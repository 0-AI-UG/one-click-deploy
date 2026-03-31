import type { DeployRequest, ServerWithApps } from "../shared/rpc.ts";
import * as db from "./db.ts";
import * as hetzner from "./hetzner.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function deploy(
  req: DeployRequest,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const deployStart = Date.now();
  log("start", "Deploy request:", { app_name: req.app_name, git_repo: req.git_repo, domain: req.domain, server_id: req.server_id, container_port: req.container_port });

  try {
    const settings = db.getSettings();
    log("settings", "Loaded settings", { hasApiToken: !!settings.hetzner_api_token, hasDnsToken: !!settings.hetzner_dns_token, dnsZoneId: settings.dns_zone_id, serverType: settings.default_server_type, location: settings.default_location });
    let serverId = req.server_id;
    let serverIp = "";

    // Step 1: Get or create server
    if (serverId) {
      onProgress("server", "Using existing server...");
      log("server", `Looking up existing server id=${serverId}`);
      const server = db.getServer(serverId);
      if (!server) {
        log("server", `Server id=${serverId} not found in DB`);
        throw new Error("Server not found");
      }
      serverIp = server.ipv4;
      log("server", `Using existing server: ${server.name} ip=${serverIp} status=${server.status}`);
      onProgress("server", `Using server ${server.name} (${serverIp})`);
    } else {
      onProgress("server", "Creating new Hetzner server...");

      log("ssh", "Ensuring SSH key exists...");
      const sshKeyStart = Date.now();
      const sshKey = await hetzner.ensureSshKey("one-click-deploy");
      log("ssh", `SSH key ready in ${Date.now() - sshKeyStart}ms: ${sshKey.name}`);
      onProgress("server", `SSH key ready: ${sshKey.name}`);

      const serverType = req.server_type || settings.default_server_type || "cx23";
      const location = req.server_location || settings.default_location || "nbg1";
      const serverName = `ocd-${req.app_name}-${Date.now()}`;

      log("server", `Creating Hetzner server: name=${serverName} type=${serverType} location=${location} ssh_key=${sshKey.name}`);
      const createStart = Date.now();
      const hServer = await hetzner.createServer({
        name: serverName,
        server_type: serverType,
        location,
        ssh_key_name: sshKey.name,
      });
      log("server", `Hetzner server created in ${Date.now() - createStart}ms: id=${hServer.id} ip=${hServer.public_net.ipv4.ip}`);

      serverIp = hServer.public_net.ipv4.ip;
      const dbServer = db.insertServer({
        name: serverName,
        hetzner_id: String(hServer.id),
        ipv4: serverIp,
        ipv6: hServer.public_net.ipv6.ip || "",
        type: serverType,
        location,
        status: "provisioning",
      });
      serverId = dbServer.id;
      log("server", `Server saved to DB: id=${dbServer.id}`);
      onProgress("server", `Server created: ${serverName} (${serverIp})`);

      // Wait for provisioning
      onProgress("provision", "Waiting for server to be ready...");
      log("provision", `Waiting for server ${serverIp} to be provisioned (polling SSH)...`);
      const provisionStart = Date.now();
      await hetzner.waitForServer(serverIp, 30, (msg) => {
        onProgress("provision", msg);
      });
      log("provision", `Server provisioned in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`);

      // Verify docker is actually installed
      const dockerCheck = await hetzner.sshExec(serverIp, "docker --version");
      if (dockerCheck.exitCode !== 0) {
        const initLog = await hetzner.sshExec(serverIp, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
        log("provision", `Docker not found. Cloud-init log:\n${initLog.stdout}`);
        throw new Error(`Server provisioned but Docker not installed. Cloud-init log:\n${initLog.stdout.trim()}`);
      }
      log("provision", `Docker verified: ${dockerCheck.stdout.trim()}`);

      db.updateServerStatus(dbServer.id, "ready");
      onProgress("provision", "Server provisioned with Docker + Caddy");
    }

    // Step 2: Determine domain + create DNS record
    const useDomain = req.domain || `${serverIp}.nip.io`;
    const useInternalTls = !req.domain;
    log("dns", `Domain: ${useDomain} (internal TLS: ${useInternalTls})`);

    onProgress("dns", req.domain ? `Creating DNS record for ${req.domain}...` : `Using ${useDomain} (no custom domain)`);
    const dnsZoneId = settings.dns_zone_id;

    // Extract subdomain from full domain
    const parts = useDomain.split(".");
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
    log("dns", `Subdomain: ${subdomain}, zone: ${dnsZoneId || "(none)"}`);

    let dnsRecordId: string | null = null;
    if (req.domain && dnsZoneId) {
      try {
        log("dns", `Creating DNS A record: ${subdomain} -> ${serverIp} in zone ${dnsZoneId}`);
        const dnsStart = Date.now();
        const record = await hetzner.createDnsRecord({
          zone_id: dnsZoneId,
          name: subdomain,
          type: "A",
          value: serverIp,
        });
        dnsRecordId = record.id;
        log("dns", `DNS record created in ${Date.now() - dnsStart}ms: id=${record.id}`);
        onProgress("dns", `DNS A record created: ${req.domain} -> ${serverIp}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("dns", `DNS record creation failed: ${msg}`);
        onProgress("dns", `DNS failed (continuing): ${msg}`);
      }
    } else if (req.domain) {
      log("dns", "No DNS zone configured, skipping");
      onProgress("dns", "No DNS zone configured, skipping DNS record");
    } else {
      log("dns", `Using nip.io domain: ${useDomain}`);
      onProgress("dns", `Will use ${useDomain}`);
    }

    // Step 3: Clone repo, find Dockerfile, build & run
    onProgress("build", `Cloning ${req.git_repo} and building...`);
    log("build", `Starting clone & build for ${req.git_repo}`);

    let dockerfilePath = "Dockerfile";
    const createApp = () =>
      db.insertApp({
        server_id: serverId!,
        name: req.app_name,
        domain: useDomain,
        git_repo: req.git_repo,
        dockerfile_path: dockerfilePath,
        container_port: req.container_port,
        env_vars: JSON.stringify(req.env_vars),
      });

    const app = createApp();
    log("build", `App record created: id=${app.id}`);

    if (dnsRecordId && dnsZoneId) {
      db.insertDnsRecord({
        app_id: app.id,
        zone_id: dnsZoneId,
        record_id: dnsRecordId,
        name: subdomain,
        type: "A",
        value: serverIp,
      });
      log("dns", `DNS record linked to app id=${app.id}`);
    }

    try {
      const buildStart = Date.now();
      const result = await hetzner.cloneAndBuild(
        serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          envVars: req.env_vars,
        },
        (line) => {
          db.appendDeployLog(app.id, `[build] ${line}`);
          onProgress("build", line);
        }
      );
      dockerfilePath = result.dockerfilePath;
      log("build", `Clone & build completed in ${((Date.now() - buildStart) / 1000).toFixed(1)}s, dockerfile=${dockerfilePath}, container=${result.containerId}`);
      onProgress("build", "Container running");

      // Step 4: Configure Caddy reverse proxy
      onProgress("caddy", `Configuring TLS + reverse proxy for ${useDomain}...`);
      log("caddy", `Configuring Caddy: domain=${useDomain} port=${req.container_port} internalTls=${useInternalTls}`);
      const caddyStart = Date.now();
      await hetzner.deployCaddySite(serverIp, useDomain, req.container_port, useInternalTls);
      log("caddy", `Caddy configured in ${Date.now() - caddyStart}ms`);
      db.appendDeployLog(app.id, `[caddy] Reverse proxy configured for ${useDomain}`);
      onProgress("caddy", useInternalTls ? "Caddy configured with self-signed TLS" : "Caddy configured with auto-TLS");

      // Done
      db.updateAppStatus(app.id, "running");
      db.appendDeployLog(app.id, `[done] App deployed successfully`);
      log("done", `Deploy completed successfully in ${((Date.now() - deployStart) / 1000).toFixed(1)}s — https://${useDomain}`);
      onProgress("done", `Deployed! https://${useDomain}`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `Build/run failed after ${((Date.now() - deployStart) / 1000).toFixed(1)}s:`, msg);
      if (err instanceof Error && err.stack) log("error", "Stack:", err.stack);
      db.appendDeployLog(app.id, `[error] ${msg}`);
      db.updateAppStatus(app.id, "error");
      onProgress("error", msg);
      return { ok: false, error: msg };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Deploy failed after ${((Date.now() - deployStart) / 1000).toFixed(1)}s:`, msg);
    if (err instanceof Error && err.stack) log("error", "Stack:", err.stack);
    onProgress("error", msg);
    return { ok: false, error: msg };
  }
}

export async function destroyApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("destroyApp", `Destroying app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) {
      log("destroyApp", `App id=${appId} not found`);
      throw new Error("App not found");
    }
    log("destroyApp", `App: name=${app.name} domain=${app.domain} server_id=${app.server_id}`);

    const server = db.getServer(app.server_id);

    // Remove container and app directory
    if (server) {
      log("destroyApp", `Removing container ${app.name} from ${server.ipv4}`);
      await hetzner.removeContainer(server.ipv4, app.name);
      log("destroyApp", `Removing Caddy site ${app.domain}`);
      await hetzner.removeCaddySite(server.ipv4, app.domain);
      log("destroyApp", `Removing app directory /home/deploy/apps/${app.name}`);
      await hetzner.sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`);
    } else {
      log("destroyApp", `Server id=${app.server_id} not found, skipping remote cleanup`);
    }

    // Remove DNS records
    const dnsRecords = db.getDnsRecords(appId);
    log("destroyApp", `Removing ${dnsRecords.length} DNS records`);
    for (const record of dnsRecords) {
      try {
        await hetzner.deleteDnsRecord(record.record_id);
        log("destroyApp", `Deleted DNS record ${record.record_id}`);
      } catch (err) {
        log("destroyApp", `Failed to delete DNS record ${record.record_id}:`, err instanceof Error ? err.message : err);
      }
    }

    db.deleteApp(appId);
    log("destroyApp", `App id=${appId} destroyed successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("destroyApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function destroyServer(serverId: number): Promise<{ ok: boolean; error?: string }> {
  log("destroyServer", `Destroying server id=${serverId}`);
  try {
    const server = db.getServer(serverId);
    if (!server) {
      log("destroyServer", `Server id=${serverId} not found`);
      throw new Error("Server not found");
    }
    log("destroyServer", `Server: name=${server.name} hetzner_id=${server.hetzner_id} ip=${server.ipv4}`);

    // Destroy all apps first
    const apps = db.getApps(serverId);
    log("destroyServer", `Destroying ${apps.length} apps on server`);
    for (const app of apps) {
      await destroyApp(app.id);
    }

    // Delete Hetzner server
    log("destroyServer", `Deleting Hetzner server ${server.hetzner_id}`);
    await hetzner.deleteHetznerServer(server.hetzner_id);
    db.deleteServer(serverId);
    log("destroyServer", `Server id=${serverId} destroyed successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("destroyServer", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export function getServersWithApps(): ServerWithApps[] {
  const servers = db.getServers();
  return servers.map((s) => ({
    ...s,
    apps: db.getApps(s.id),
  }));
}
