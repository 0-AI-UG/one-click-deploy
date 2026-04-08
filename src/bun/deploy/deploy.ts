import type { DeployRequest } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import * as github from "../github.ts";
import { validateDeployRequest } from "../validate.ts";
import { createMasker } from "../mask.ts";
import { getTokens } from "../secret-store.ts";
import { scaleApp } from "../scale.ts";
import { performSelfDeployHandoff } from "./self-deploy.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

// Silent SSH exec for compose detection (swallows errors)
async function sshExecForDetection(ip: string, cmd: string) {
  try {
    return await hetzner.sshExec(ip, cmd);
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

// Tracks resources created during deploy for rollback on failure
type DeployState = {
  hetznerServerId?: string;
  dbServerId?: number;
  dbAppId?: number;
  dnsRecord?: { zone_id: string; name: string; type: string; value: string };
  containerName?: string;
  deployMode?: "dockerfile" | "compose";
  caddyConfigured?: boolean;
  caddyDomain?: string;
  serverIsNew?: boolean;
  volumeId?: string;
};

async function rollback(state: DeployState, serverIp: string, hostKey?: string): Promise<void> {
  log("rollback", "Rolling back deploy state:", state);

  // Remove Caddy site
  if (state.caddyConfigured && state.caddyDomain && serverIp) {
    try {
      await hetzner.removeCaddySite(serverIp, state.caddyDomain, hostKey);
      log("rollback", "Removed Caddy site");
    } catch (err) {
      log("rollback", `Failed to remove Caddy site: ${err}`);
    }
  }

  // Remove container(s)
  if (state.containerName && serverIp) {
    try {
      if (state.deployMode === "compose") {
        await hetzner.removeCompose(serverIp, state.containerName, false, hostKey);
      } else {
        await hetzner.removeContainer(serverIp, state.containerName, hostKey);
      }
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
  if (state.dnsRecord) {
    try {
      await hetzner.deleteDnsRecord(state.dnsRecord);
      log("rollback", `Deleted DNS record ${state.dnsRecord.name}/${state.dnsRecord.type}`);
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

  // Self-deploy needs a persistent volume (so the handed-off DB survives
  // restarts) and a JWT_SECRET env var (used to re-encrypt the token).
  if (req.self_deploy) {
    if (!req.volume_size || req.volume_size <= 0) {
      return { ok: false, error: "Self-deploy requires a persistent volume" };
    }
    if (!req.env_vars.JWT_SECRET) {
      return { ok: false, error: "Self-deploy requires JWT_SECRET in env vars" };
    }
  }

  // Set up log masking for secrets
  const tokens = await getTokens();
  const githubPat = tokens.github_pat || undefined;
  log("deploy", `GitHub PAT ${githubPat ? `present (${githubPat.length} chars)` : "not configured"}`);
  const secretValues = [
    tokens.hetzner_api_token,
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

      const serverType = req.server_type || settings.default_server_type;
      if (!serverType) throw new Error("No server type specified — configure a default in Settings");
      const location = req.server_location || settings.default_location;
      if (!location) throw new Error("No server location specified — configure a default in Settings");
      const serverName = `ocd-${req.app_name}-${Date.now()}`;

      // Insert placeholder DB record BEFORE Hetzner API call to prevent orphans
      const dbServer = db.insertServer({
        name: serverName,
        hetzner_id: "",
        ipv4: "",
        ipv6: "",
        type: serverType,
        location,
        status: "creating",
      });
      serverId = dbServer.id;
      state.dbServerId = dbServer.id;
      state.serverIsNew = true;

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
      log("server", `Hetzner server created in ${Date.now() - createStart}ms: id=${hServer.id}`);

      // Update placeholder with real data
      serverIp = hServer.public_net.ipv4.ip;
      db.updateServer(dbServer.id, {
        hetzner_id: String(hServer.id),
        ipv4: serverIp,
        ipv6: hServer.public_net.ipv6.ip || "",
        status: "provisioning",
      });
      log("server", `Server saved to DB: id=${dbServer.id}`);
      onProgress("server", `Server created: ${serverName} (${serverIp})`);

      // Wait for server VM to boot before attempting SSH
      onProgress("provision", "Waiting for server to boot...");
      await hetzner.waitForServerRunning(hServer.id, (msg) => {
        onProgress("provision", msg);
      });

      // Wait for cloud-init provisioning
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
        throw new Error("Server provisioned but Docker was not installed — server setup may have failed. Try deleting the server and deploying again.");
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
        state.dnsRecord = { zone_id: dnsZoneId, name: subdomain, type: "A", value: serverIp };
        log("dns", `DNS record created: ${record.id}`);
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

      // Self-deploy: copy the local bootstrap DB onto the mounted volume
      // *before* the container starts, so the hosted instance boots with
      // full knowledge of itself, its server, and the Hetzner token.
      if (req.self_deploy) {
        onProgress("build", "Handing off panel database to hosted instance...");
        await performSelfDeployHandoff({
          serverIp,
          hostKey: serverHostKey || undefined,
          hostMountPath,
          newJwtSecret: req.env_vars.JWT_SECRET!,
        });
        onProgress("build", "Panel database handed off");
      }
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

    if (state.dnsRecord) {
      db.insertDnsRecord({
        app_id: app.id,
        zone_id: state.dnsRecord.zone_id,
        record_id: `${state.dnsRecord.name}/${state.dnsRecord.type}/${state.dnsRecord.value}`,
        name: state.dnsRecord.name,
        type: state.dnsRecord.type,
        value: state.dnsRecord.value,
      });
    }

    // Persist volume association
    if (state.volumeId && volumeMount) {
      db.updateAppVolume(app.id, state.volumeId, volumeMount);
    }

    const buildStart = Date.now();
    let deployMode: "dockerfile" | "compose" = "dockerfile";
    let composeFile = "";
    let composeWebService = "";

    // Determine deploy mode: compose auto-detection only if no explicit dockerfile_path
    if (!req.dockerfile_path) {
      // Clone first to detect compose file
      const detected = req.compose_file || await (async () => {
        // Need to clone before we can detect — cloneAndBuild/cloneAndComposeBuild handle this
        // Do a preliminary clone to check for compose files
        await hetzner.sshExec(serverIp, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps`);
        const appDir = `/home/deploy/apps/${req.app_name}`;
        const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
        let cloneUrl = req.git_repo;
        if (githubPat && cloneUrl.match(/^https:\/\/github\.com\//)) {
          cloneUrl = cloneUrl.replace(/^https:\/\/github\.com\//, `https://x-access-token:${githubPat}@github.com/`);
        }
        const gitEnv = githubPat ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
        await sshExecForDetection(serverIp, asUser(`${gitEnv}if [ -d "${appDir}/.git" ]; then cd ${appDir} && git pull; else rm -rf ${appDir} && git clone ${cloneUrl} ${appDir}; fi`));
        if (githubPat && cloneUrl !== req.git_repo) {
          await sshExecForDetection(serverIp, asUser(`cd ${appDir} && git remote set-url origin ${req.git_repo}`));
        }
        return await hetzner.detectComposeFile(serverIp, req.app_name, serverHostKey || undefined);
      })();

      if (detected) {
        deployMode = "compose";
        composeFile = detected;
        composeWebService = req.compose_web_service ||
          await hetzner.detectWebService(serverIp, req.app_name, detected, serverHostKey || undefined) ||
          "web";
        log("build", `Compose mode detected: file=${composeFile} service=${composeWebService}`);
      }
    }

    state.deployMode = deployMode;
    let buildImageTag = `${req.app_name}:latest`; // default, overridden by Dockerfile builds

    if (deployMode === "compose") {
      const result = await hetzner.cloneAndComposeBuild(
        serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          hostPort: app.host_port,
          envVars: req.env_vars,
          volumeMount,
          composeFile,
          webService: composeWebService,
          gitToken: githubPat,
        },
        (line) => {
          maskedLog(app.id, `[build] ${line}`);
          onProgress("build", mask(line));
        }
      );
      db.updateAppDeployMode(app.id, "compose", result.composeFile, result.webService);
    } else {
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
      if (result.imageTag) {
        buildImageTag = result.imageTag;
      }
    }
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
    const health = deployMode === "compose"
      ? await hetzner.composeHealthCheck(serverIp, req.app_name, app.host_port, 5, serverHostKey || undefined)
      : await hetzner.healthCheck(serverIp, req.app_name, app.host_port, 5, serverHostKey || undefined);
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
    const gitCommitResult = await hetzner.sshExec(
      serverIp,
      `su - deploy -c "cd /home/deploy/apps/${req.app_name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
      serverHostKey || undefined
    );
    const gitCommit = gitCommitResult.stdout.trim();
    db.insertDeployment({
      app_id: app.id,
      image_tag: buildImageTag,
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
          app.host_port, webhookBranch, githubPat, hostKey,
          deployMode, composeFile || undefined,
          req.container_port, volumeMount
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

    // Create initial replica record
    db.insertReplica({
      app_id: app.id,
      server_id: serverId!,
      host_port: app.host_port,
      container_name: req.app_name,
      status: health.healthy ? "running" : "unhealthy",
    });

    // Scale up if replicas > 1 requested
    if (req.replicas && req.replicas > 1) {
      onProgress("health", `Scaling to ${req.replicas} replicas...`);
      db.updateAppScaling(app.id, {
        desired_replicas: req.replicas,
        min_replicas: 1,
        max_replicas: req.replicas,
      });
      const scaleResult = await scaleApp(app.id, req.replicas, (step, detail) => {
        onProgress(step, detail);
      });
      if (!scaleResult.ok) {
        maskedLog(app.id, `[scale] Warning: scaling failed: ${scaleResult.error}`);
        onProgress("health", `Warning: scaling to ${req.replicas} replicas failed: ${scaleResult.error}`);
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
      await rollback(state, serverIp, serverHostKey || undefined);
    } catch (rollbackErr) {
      log("error", "Rollback also failed:", rollbackErr);
    }

    onProgress("error", mask(msg));
    return { ok: false, error: mask(msg) };
  }
}
