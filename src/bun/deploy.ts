import type { DeployRequest, ServerWithApps } from "../shared/rpc.ts";
import * as db from "./db.ts";
import * as hetzner from "./hetzner.ts";
import * as github from "./github.ts";
import { validateDeployRequest, validateEnvVars } from "./validate.ts";
import { createMasker } from "./mask.ts";
import { getTokens } from "./keychain.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

// Tracks resources created during deploy for rollback on failure
type DeployState = {
  hetznerServerId?: string;
  dbServerId?: number;
  dbAppId?: number;
  dnsRecordId?: string;
  dnsZoneId?: string;
  containerName?: string;
  caddyConfigured?: boolean;
  caddyDomain?: string;
  serverIsNew?: boolean;
  volumeId?: string;
};

async function rollback(state: DeployState, serverIp: string): Promise<void> {
  log("rollback", "Rolling back deploy state:", state);

  // Remove Caddy site
  if (state.caddyConfigured && state.caddyDomain && serverIp) {
    try {
      await hetzner.removeCaddySite(serverIp, state.caddyDomain);
      log("rollback", "Removed Caddy site");
    } catch (err) {
      log("rollback", `Failed to remove Caddy site: ${err}`);
    }
  }

  // Remove container
  if (state.containerName && serverIp) {
    try {
      await hetzner.removeContainer(serverIp, state.containerName);
      log("rollback", `Removed container ${state.containerName}`);
    } catch (err) {
      log("rollback", `Failed to remove container: ${err}`);
    }
  }

  // Delete volume
  if (state.volumeId) {
    try {
      await hetzner.deleteVolume(state.volumeId);
      log("rollback", `Deleted volume ${state.volumeId}`);
    } catch (err) {
      log("rollback", `Failed to delete volume: ${err}`);
    }
  }

  // Delete DNS record
  if (state.dnsRecordId) {
    try {
      await hetzner.deleteDnsRecord(state.dnsRecordId);
      log("rollback", `Deleted DNS record ${state.dnsRecordId}`);
    } catch (err) {
      log("rollback", `Failed to delete DNS record: ${err}`);
    }
  }

  // Delete app record from DB
  if (state.dbAppId) {
    try {
      db.deleteApp(state.dbAppId);
      log("rollback", `Deleted app record ${state.dbAppId}`);
    } catch (err) {
      log("rollback", `Failed to delete app record: ${err}`);
    }
  }

  // Delete newly created server (only if we created it and no other apps exist)
  if (state.serverIsNew && state.dbServerId) {
    const remainingApps = db.getApps(state.dbServerId);
    if (remainingApps.length === 0) {
      try {
        if (state.hetznerServerId) {
          await hetzner.deleteHetznerServer(state.hetznerServerId);
        }
        db.deleteServer(state.dbServerId);
        log("rollback", `Deleted server ${state.dbServerId}`);
      } catch (err) {
        log("rollback", `Failed to delete server: ${err}`);
      }
    }
  }

  log("rollback", "Rollback complete");
}

export async function deploy(
  req: DeployRequest,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const deployStart = Date.now();
  log("start", "Deploy request:", { app_name: req.app_name, git_repo: req.git_repo, domain: req.domain, server_id: req.server_id, container_port: req.container_port });

  // Validate all inputs before any side effects
  const validation = validateDeployRequest(req);
  if (!validation.valid) {
    log("validation", `Failed: ${validation.error}`);
    return { ok: false, error: validation.error };
  }

  // Set up log masking for secrets
  const tokens = await getTokens();
  const githubPat = tokens.github_pat || undefined;
  log("deploy", `GitHub PAT ${githubPat ? `present (${githubPat.length} chars)` : "not configured"}`);
  const secretValues = [
    tokens.hetzner_api_token,
    tokens.hetzner_dns_token,
    ...(githubPat ? [githubPat] : []),
    ...Object.values(req.env_vars),
  ];
  const mask = createMasker(secretValues);

  const maskedLog = (appId: number, line: string) => {
    db.appendDeployLog(appId, mask(line));
  };

  const state: DeployState = {};
  let serverIp = "";
  let serverHostKey = "";

  try {
    const settings = db.getSettings();
    log("settings", "Loaded settings");
    let serverId = req.server_id;

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
      serverHostKey = server.ssh_host_key || "";
      log("server", `Using existing server: ${server.name} ip=${serverIp} status=${server.status}`);
      onProgress("server", `Using server ${server.name} (${serverIp})`);
    } else {
      onProgress("server", "Creating new Hetzner server...");

      log("ssh", "Ensuring SSH key and firewall exist...");
      const [sshKey, firewallId] = await Promise.all([
        hetzner.ensureSshKey("one-click-deploy"),
        hetzner.ensureFirewall(),
      ]);
      log("ssh", `SSH key ready: ${sshKey.name}, firewall: ${firewallId}`);
      onProgress("server", `SSH key + firewall ready`);

      const serverType = req.server_type || settings.default_server_type || "cx23";
      const location = req.server_location || settings.default_location || "nbg1";
      const serverName = `ocd-${req.app_name}-${Date.now()}`;

      log("server", `Creating Hetzner server: name=${serverName} type=${serverType} location=${location}`);
      const createStart = Date.now();
      const hServer = await hetzner.createServer({
        name: serverName,
        server_type: serverType,
        location,
        ssh_key_name: sshKey.name,
        firewall_id: firewallId,
      });
      state.hetznerServerId = String(hServer.id);
      state.serverIsNew = true;
      log("server", `Hetzner server created in ${Date.now() - createStart}ms: id=${hServer.id}`);

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
      state.dbServerId = dbServer.id;
      log("server", `Server saved to DB: id=${dbServer.id}`);
      onProgress("server", `Server created: ${serverName} (${serverIp})`);

      // Wait for provisioning
      onProgress("provision", "Waiting for server to be ready...");
      log("provision", `Waiting for server ${serverIp} to be provisioned...`);
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

      // Capture SSH host key for future verification
      serverHostKey = await hetzner.captureHostKey(serverIp);
      if (serverHostKey) {
        db.updateServerHostKey(dbServer.id, serverHostKey);
        log("provision", "SSH host key captured and stored");
      }

      db.updateServerStatus(dbServer.id, "ready");
      onProgress("provision", "Server provisioned with Docker + Caddy");
    }

    // Step 2: Determine domain + create DNS record
    const useDomain = req.domain || `${req.app_name}.${serverIp}.nip.io`;
    const useInternalTls = !req.domain;
    log("dns", `Domain: ${useDomain} (internal TLS: ${useInternalTls})`);

    onProgress("dns", req.domain ? `Creating DNS record for ${req.domain}...` : `Using ${useDomain} (no custom domain)`);
    const dnsZoneId = settings.dns_zone_id;

    // Extract subdomain from full domain
    const parts = useDomain.split(".");
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

    if (req.domain && dnsZoneId) {
      try {
        log("dns", `Creating DNS A record: ${subdomain} -> ${serverIp} in zone ${dnsZoneId}`);
        const record = await hetzner.createDnsRecord({
          zone_id: dnsZoneId,
          name: subdomain,
          type: "A",
          value: serverIp,
        });
        state.dnsRecordId = record.id;
        state.dnsZoneId = dnsZoneId;
        log("dns", `DNS record created: id=${record.id}`);
        onProgress("dns", `DNS A record created: ${req.domain} -> ${serverIp}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("dns", `DNS record creation failed: ${msg}`);
        onProgress("dns", `DNS failed (continuing): ${msg}`);
      }
    } else if (req.domain) {
      onProgress("dns", "No DNS zone configured, skipping DNS record");
    } else {
      onProgress("dns", `Will use ${useDomain}`);
    }

    // Step 3: Create volume if requested
    let volumeMount: string | undefined;
    if (req.volume_size && req.volume_size > 0) {
      // Get the Hetzner server ID (either from new server or existing)
      let hetznerServerId: number;
      if (state.hetznerServerId) {
        hetznerServerId = parseInt(state.hetznerServerId, 10);
      } else {
        const existingServer = db.getServer(serverId!);
        hetznerServerId = parseInt(existingServer.hetzner_id, 10);
      }

      onProgress("build", `Creating ${req.volume_size}GB persistent volume...`);
      const vol = await hetzner.createVolume({
        name: `ocd-${req.app_name}-data`,
        size: req.volume_size,
        server_id: hetznerServerId,
        location: req.server_location || settings.default_location || "nbg1",
      });
      state.volumeId = String(vol.id);
      const hostMountPath = `/mnt/ocd-${req.app_name}-data`;
      const containerPath = req.volume_path || "/data";
      await hetzner.sshExec(serverIp, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, serverHostKey || undefined);
      volumeMount = `${hostMountPath}:${containerPath}`;
      log("build", `Volume mounted: ${volumeMount}`);
      onProgress("build", `Volume ready (${req.volume_size}GB at /data)`);
    }

    // Step 4: Create app record, then clone & build
    onProgress("build", `Cloning ${req.git_repo} and building...`);

    let dockerfilePath = req.dockerfile_path || "Dockerfile";
    const app = db.insertApp({
      server_id: serverId!,
      name: req.app_name,
      domain: useDomain,
      git_repo: req.git_repo,
      dockerfile_path: dockerfilePath,
      container_port: req.container_port,
      env_vars: JSON.stringify(req.env_vars),
      auth_password: req.auth_password,
    });
    state.dbAppId = app.id;
    state.containerName = req.app_name;
    log("build", `App record created: id=${app.id}`);

    if (state.dnsRecordId && state.dnsZoneId) {
      db.insertDnsRecord({
        app_id: app.id,
        zone_id: state.dnsZoneId,
        record_id: state.dnsRecordId,
        name: subdomain,
        type: "A",
        value: serverIp,
      });
    }

    // Persist volume association
    if (state.volumeId && volumeMount) {
      db.updateAppVolume(app.id, state.volumeId, volumeMount);
    }

    const buildStart = Date.now();
    const result = await hetzner.cloneAndBuild(
      serverIp,
      {
        name: req.app_name,
        gitRepo: req.git_repo,
        port: req.container_port,
        hostPort: app.host_port,
        envVars: req.env_vars,
        volumeMount,
        dockerfilePath: req.dockerfile_path,
        gitToken: githubPat,
      },
      (line) => {
        maskedLog(app.id, `[build] ${line}`);
        onProgress("build", mask(line));
      }
    );
    dockerfilePath = result.dockerfilePath;
    log("build", `Clone & build completed in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
    onProgress("build", "Container running");

    // Step 4b: Deploy auth proxy if password protection is enabled
    let caddyPort = app.host_port;
    if (req.auth_password) {
      onProgress("build", "Deploying auth proxy...");
      caddyPort = await hetzner.deployAuthProxy(serverIp, req.app_name, req.auth_password, app.host_port, serverHostKey || undefined);
      maskedLog(app.id, `[auth] Auth proxy deployed on port ${caddyPort}`);
    }

    // Step 5: Configure Caddy reverse proxy
    onProgress("caddy", `Configuring TLS + reverse proxy for ${useDomain}...`);
    await hetzner.deployCaddySite(serverIp, useDomain, caddyPort, useInternalTls, serverHostKey || undefined);
    state.caddyConfigured = true;
    state.caddyDomain = useDomain;
    maskedLog(app.id, `[caddy] Reverse proxy configured for ${useDomain}`);
    onProgress("caddy", useInternalTls ? "Caddy configured with self-signed TLS" : "Caddy configured with auto-TLS");

    // Step 5: Health check
    onProgress("health", "Checking app health...");
    const health = await hetzner.healthCheck(serverIp, req.app_name, app.host_port, 5, serverHostKey || undefined);
    if (health.healthy) {
      maskedLog(app.id, `[health] Health check passed (HTTP ${health.statusCode})`);
      onProgress("health", `Health check passed (HTTP ${health.statusCode})`);
      db.updateAppStatus(app.id, "running");
    } else {
      maskedLog(app.id, `[health] ${health.error || "Health check failed"}`);
      onProgress("health", `Warning: ${health.error || "Health check failed"} — app may still be starting`);
      db.updateAppStatus(app.id, "unhealthy");
    }

    // Record deployment history
    const imageTag = `${req.app_name}:latest`;
    const gitCommitResult = await hetzner.sshExec(
      serverIp,
      `su - deploy -c "cd /home/deploy/apps/${req.app_name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
      serverHostKey || undefined
    );
    const gitCommit = gitCommitResult.stdout.trim();
    db.insertDeployment({
      app_id: app.id,
      image_tag: imageTag,
      git_commit: gitCommit,
    });

    // Set up webhook for auto-redeploy if requested
    if (req.webhook_enabled && githubPat) {
      try {
        const webhookBranch = req.webhook_branch || "main";
        const webhookSecret = crypto.randomUUID();
        const hostKey = serverHostKey || undefined;

        await hetzner.deployWebhookReceiver(serverIp, hostKey);
        await hetzner.ensureWebhookCaddyRoute(serverIp, hostKey);
        await hetzner.setupAppWebhook(
          serverIp, req.app_name, webhookSecret,
          app.host_port, webhookBranch, githubPat, hostKey
        );

        const webhook = await github.createWebhook({
          gitRepo: req.git_repo,
          appName: req.app_name,
          serverDomain: useDomain,
          webhookSecret,
          token: githubPat,
        });

        db.updateAppWebhook(app.id, true, webhookSecret, webhookBranch, String(webhook.id));
        maskedLog(app.id, `[webhook] Auto-redeploy enabled on branch ${webhookBranch}`);
        onProgress("health", `Webhook configured for auto-redeploy on ${webhookBranch}`);
      } catch (err) {
        const webhookErr = err instanceof Error ? err.message : String(err);
        maskedLog(app.id, `[webhook] Warning: failed to set up webhook: ${webhookErr}`);
        log("webhook", `Webhook setup failed (non-fatal): ${webhookErr}`);
      }
    }

    maskedLog(app.id, `[done] App deployed successfully`);
    log("done", `Deploy completed in ${((Date.now() - deployStart) / 1000).toFixed(1)}s — https://${useDomain}`);
    onProgress("done", `Deployed! https://${useDomain}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Deploy failed after ${((Date.now() - deployStart) / 1000).toFixed(1)}s:`, msg);
    if (err instanceof Error && err.stack) log("error", "Stack:", err.stack);

    // Clean up any resources created during this deploy
    try {
      await rollback(state, serverIp);
    } catch (rollbackErr) {
      log("error", "Rollback also failed:", rollbackErr);
    }

    onProgress("error", mask(msg));
    return { ok: false, error: mask(msg) };
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

    const server = db.getServer(app.server_id);

    // Clean up GitHub webhook if enabled
    if (app.webhook_enabled && app.github_webhook_id) {
      try {
        const pat = await github.getGitHubPat();
        if (pat) {
          await github.deleteWebhook({
            gitRepo: app.git_repo,
            webhookId: app.github_webhook_id,
            token: pat,
          });
        }
      } catch (err) {
        log("destroyApp", `Failed to delete GitHub webhook: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      // Remove webhook config from server
      if (app.webhook_enabled) {
        await hetzner.removeAppWebhook(server.ipv4, app.name, hostKey);
      }
      // Remove auth proxy if enabled
      if (app.auth_password) {
        await hetzner.removeAuthProxy(server.ipv4, app.name, hostKey);
      }
      await hetzner.removeContainer(server.ipv4, app.name);
      await hetzner.removeCaddySite(server.ipv4, app.domain, hostKey);
      await hetzner.sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
    }

    const dnsRecords = db.getDnsRecords(appId);
    for (const record of dnsRecords) {
      try {
        await hetzner.deleteDnsRecord(record.record_id);
      } catch (err) {
        log("destroyApp", `Failed to delete DNS record ${record.record_id}:`, err instanceof Error ? err.message : err);
      }
    }

    // Delete Hetzner volume if attached
    if (app.volume_id) {
      try {
        await hetzner.deleteVolume(app.volume_id);
        log("destroyApp", `Deleted volume ${app.volume_id}`);
      } catch (err) {
        log("destroyApp", `Failed to delete volume ${app.volume_id}:`, err instanceof Error ? err.message : err);
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
    if (!server) throw new Error("Server not found");

    const apps = db.getApps(serverId);
    for (const app of apps) {
      await destroyApp(app.id);
    }

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

export async function restartApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("restartApp", `Restarting app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    const hostKey = server.ssh_host_key || undefined;
    await hetzner.restartContainer(server.ipv4, app.name, hostKey);

    const health = await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    log("restartApp", `App id=${appId} restarted, healthy=${health.healthy}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("restartApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function pauseApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("pauseApp", `Pausing app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    const hostKey = server.ssh_host_key || undefined;
    await hetzner.pauseContainer(server.ipv4, app.name, hostKey);
    db.updateAppStatus(appId, "paused");

    log("pauseApp", `App id=${appId} paused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("pauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function unpauseApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("unpauseApp", `Unpausing app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    const hostKey = server.ssh_host_key || undefined;
    await hetzner.unpauseContainer(server.ipv4, app.name, hostKey);

    const health = await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    log("unpauseApp", `App id=${appId} unpaused, healthy=${health.healthy}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("unpauseApp", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function redeployApp(
  appId: number,
  onProgress: ProgressFn,
  newEnvVars?: Record<string, string>,
  newAuthPassword?: string | null
): Promise<{ ok: boolean; error?: string }> {
  log("redeployApp", `Redeploying app id=${appId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    if (newEnvVars) {
      db.updateAppEnvVars(appId, JSON.stringify(newEnvVars));
    }
    // Update auth password: string = set/change, null = remove, undefined = no change
    if (newAuthPassword !== undefined) {
      db.updateAppAuthPassword(appId, newAuthPassword || "");
    }
    const authPassword = newAuthPassword !== undefined ? (newAuthPassword || "") : app.auth_password;

    const envVars = newEnvVars ?? JSON.parse(app.env_vars || "{}");
    const hostKey = server.ssh_host_key || undefined;

    const tokens = await getTokens();
    const githubPat = tokens.github_pat || undefined;

    db.updateAppStatus(appId, "deploying");
    onProgress("build", "Pulling latest code and rebuilding...");

    await hetzner.cloneAndBuild(
      server.ipv4,
      {
        name: app.name,
        gitRepo: app.git_repo,
        port: app.container_port,
        hostPort: app.host_port,
        envVars,
        volumeMount: app.volume_mount || undefined,
        dockerfilePath: app.dockerfile_path || undefined,
        gitToken: githubPat,
      },
      (line) => {
        db.appendDeployLog(appId, `[redeploy] ${line}`);
        onProgress("build", line);
      }
    );

    // Handle auth proxy: deploy, update, or remove
    let caddyPort = app.host_port;
    if (authPassword) {
      caddyPort = await hetzner.deployAuthProxy(server.ipv4, app.name, authPassword, app.host_port, hostKey);
    } else if (app.auth_password && !authPassword) {
      // Password was removed — tear down the auth proxy
      await hetzner.removeAuthProxy(server.ipv4, app.name, hostKey);
    }

    onProgress("caddy", "Reloading reverse proxy...");
    const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
    await hetzner.deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls);

    onProgress("health", "Checking app health...");
    const health = await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Record deployment
    const gitCommitResult = await hetzner.sshExec(
      server.ipv4,
      `su - deploy -c "cd /home/deploy/apps/${app.name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
      hostKey
    );
    db.insertDeployment({
      app_id: appId,
      image_tag: `${app.name}:latest`,
      git_commit: gitCommitResult.stdout.trim(),
    });

    db.appendDeployLog(appId, `[done] Redeployed successfully`);
    onProgress("done", "Redeployed successfully");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("redeployApp", `Failed:`, msg);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}

export async function updateAppEnv(
  appId: number,
  envVars: Record<string, string>
): Promise<{ ok: boolean; error?: string }> {
  log("updateAppEnv", `Updating env vars for app id=${appId}`);
  try {
    const envResult = validateEnvVars(envVars);
    if (!envResult.valid) return { ok: false, error: envResult.error };

    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");

    // Update DB
    db.updateAppEnvVars(appId, JSON.stringify(envVars));

    // Recreate container with new env vars
    const hostKey = server.ssh_host_key || undefined;
    await hetzner.removeContainer(server.ipv4, app.name);

    const tokens = await getTokens();
    const githubPat = tokens.github_pat || undefined;

    // Write new env file and start container
    await hetzner.cloneAndBuild(
      server.ipv4,
      {
        name: app.name,
        gitRepo: app.git_repo,
        port: app.container_port,
        hostPort: app.host_port,
        envVars,
        volumeMount: app.volume_mount || undefined,
        dockerfilePath: app.dockerfile_path || undefined,
        gitToken: githubPat,
      },
      (line) => {
        db.appendDeployLog(appId, `[env-update] ${line}`);
      }
    );

    const health = await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    log("updateAppEnv", `Env vars updated for app id=${appId}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("updateAppEnv", `Failed:`, msg);
    return { ok: false, error: msg };
  }
}

export async function rollbackApp(
  appId: number,
  deploymentId: number
): Promise<{ ok: boolean; error?: string }> {
  log("rollbackApp", `Rolling back app id=${appId} to deployment id=${deploymentId}`);
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const server = db.getServer(app.server_id);
    if (!server) throw new Error("Server not found");
    const deployment = db.getDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found");
    if (deployment.app_id !== appId) throw new Error("Deployment does not belong to this app");

    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

    // Stop current container
    await hetzner.removeContainer(server.ipv4, app.name);

    // Start container with the old image tag
    const envVars = JSON.parse(app.env_vars || "{}");
    const envEntries = Object.entries(envVars);
    let envFileFlag = "";
    if (envEntries.length > 0) {
      const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
      const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
      const escapedContent = envFileContent.replace(/'/g, "'\\''");
      await hetzner.sshExec(server.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, hostKey);
      envFileFlag = `--env-file ${envFilePath}`;
    }

    const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
    const cmd = `docker run -d --name ${app.name} --restart unless-stopped -p 127.0.0.1:${app.host_port}:${app.container_port} ${envFileFlag} ${volumeFlag} ${deployment.image_tag}`;
    const result = await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start container with image ${deployment.image_tag}: ${result.stderr}`);
    }

    // Health check
    const health = await hetzner.healthCheck(server.ipv4, app.name, app.host_port, 5, hostKey);
    db.updateAppStatus(appId, health.healthy ? "running" : "unhealthy");

    // Record rollback as new deployment
    db.insertDeployment({
      app_id: appId,
      image_tag: deployment.image_tag,
      git_commit: `rollback-from-${deployment.git_commit}`,
    });

    db.appendDeployLog(appId, `[rollback] Rolled back to deployment ${deploymentId} (${deployment.image_tag})`);
    log("rollbackApp", `Rollback complete for app id=${appId}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("rollbackApp", `Failed:`, msg);
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
