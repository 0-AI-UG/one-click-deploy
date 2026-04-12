import type { DeployRequest, Server } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import { getComputeProvider, getDnsProvider } from "../providers/index.ts";
import {
  sshExec, waitForServer, captureHostKey, getOrCreateLocalKeyPair,
  cloneAndBuild, cloneAndComposeBuild,
  cloneAndRailpackBuild, detectComposeFile, detectWebService, removeContainer,
  removeCompose, healthCheck, composeHealthCheck,
  deployAuthProxy,
} from "../remote/index.ts";
import { syncAppCaddy, removeAppCaddy } from "../scale/caddy-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import * as github from "../github.ts";
import { validateDeployRequest } from "../validate.ts";
import { createMasker } from "../mask.ts";
import { processIncomingEnvVars, serializeEnvVars } from "../env-crypto.ts";
import { getTokens } from "../secret-store.ts";
import { resolveGitHubToken } from "../github-token.ts";
import { scaleApp } from "../scale.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { resolve4 } from "node:dns/promises";

// Resolve a hostname to IPv4 addresses with a short timeout.
// Returns [] on failure (NXDOMAIN, timeout, etc.) so callers can treat
// "unknown" and "mismatch" distinctly.
async function resolveDomainIps(domain: string, timeoutMs = 3000): Promise<string[]> {
  try {
    return await Promise.race([
      resolve4(domain),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
    ]);
  } catch {
    return [];
  }
}

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

// Silent SSH exec for compose detection (swallows errors)
async function sshExecForDetection(ip: string, cmd: string) {
  try {
    return await sshExec(ip, cmd);
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

// Tracks resources created during deploy for rollback on failure
type DeployState = {
  providerServerId?: string;
  dbServerId?: number;
  dbAppId?: number;
  dnsRecord?: { zone_id: string; name: string; type: string; value: string };
  containerName?: string;
  appName?: string;
  deployMode?: "dockerfile" | "compose";
  caddyConfigured?: boolean;
  caddyDomain?: string;
  volumeId?: string;
  replicaId?: number;
};

async function rollback(state: DeployState, serverIp: string, hostKey?: string): Promise<void> {
  log("rollback", "Rolling back deploy state:", state);

  // Remove Caddy site from the panel ingress
  if (state.caddyConfigured && state.caddyDomain && state.appName) {
    try {
      await removeAppCaddy(state.appName, state.caddyDomain);
      log("rollback", "Removed Caddy site from panel");
    } catch (err) {
      log("rollback", `Failed to remove Caddy site: ${err}`);
    }
  }

  // Remove container(s)
  if (state.containerName && serverIp) {
    try {
      if (state.deployMode === "compose") {
        await removeCompose(serverIp, state.containerName, false, hostKey);
      } else {
        await removeContainer(serverIp, state.containerName, hostKey);
      }
      log("rollback", `Removed container ${state.containerName}`);
    } catch (err) {
      log("rollback", `Failed to remove container: ${err}`);
    }
  }

  // Delete volume
  if (state.volumeId) {
    try {
      const compute = getComputeProvider();
      await compute.volumes?.delete(state.volumeId);
      log("rollback", `Deleted volume ${state.volumeId}`);
    } catch (err) {
      log("rollback", `Failed to delete volume: ${err}`);
    }
  }

  // Delete DNS record
  if (state.dnsRecord) {
    try {
      const dns = getDnsProvider();
      await dns.deleteRecord({
        zoneId: state.dnsRecord.zone_id,
        name: state.dnsRecord.name,
        type: state.dnsRecord.type,
        value: state.dnsRecord.value,
      });
      log("rollback", `Deleted DNS record ${state.dnsRecord.name}/${state.dnsRecord.type}`);
    } catch (err) {
      log("rollback", `Failed to delete DNS record: ${err}`);
    }
  }

  // Delete replica row first (so gcServerIfEmpty can run)
  if (state.replicaId) {
    try { db.deleteReplica(state.replicaId); } catch (err) {
      log("rollback", `Failed to delete replica record: ${err}`);
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

  // GC the server: deletes only if it has zero replicas, zero apps, and is
  // not the panel's host. Handles both "we created this server" and "the
  // user reused an existing server" cases uniformly.
  if (state.dbServerId) {
    try {
      await db.gcServerIfEmpty(state.dbServerId);
    } catch (err) {
      log("rollback", `gcServerIfEmpty(${state.dbServerId}) failed: ${err}`);
    }
  }

  log("rollback", "Rollback complete");
}

export async function deploy(
  req: DeployRequest,
  onProgress: ProgressFn,
  userId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const deployStart = Date.now();
  log("start", "Deploy request:", { app_name: req.app_name, git_repo: req.git_repo, domain: req.domain, container_port: req.container_port });

  // Validate all inputs before any side effects
  const validation = validateDeployRequest(req);
  if (!validation.valid) {
    log("validation", `Failed: ${validation.error}`);
    return { ok: false, error: validation.error };
  }

  // Reject duplicate app names — same name means same container name and
  // app directory, so deploying would destroy the existing app.
  const existing = db.getAppByName(req.app_name);
  if (existing) {
    return { ok: false, error: `An app named "${req.app_name}" already exists. Choose a different name.` };
  }

  // Set up log masking for secrets
  const tokens = await getTokens();
  const resolvedGitToken = await resolveGitHubToken(userId);
  const githubPat = resolvedGitToken || undefined;
  log("deploy", `GitHub token ${githubPat ? `present (${githubPat.length} chars)` : "not configured (user has no linked GitHub)"}`);
  const envVarValues = req.env_vars
    ? Array.isArray(req.env_vars)
      ? req.env_vars.map((e) => e.value)
      : Object.values(req.env_vars)
    : [];
  const secretValues = [
    tokens.hetzner_api_token,
    ...(githubPat ? [githubPat] : []),
    ...envVarValues,
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
    let serverId: number | undefined;

    // Step 1: Reuse an existing ready server if one exists, otherwise
    // provision a new Hetzner box. Replicas table is the source of truth
    // for placement, so we don't need an explicit server selection — the
    // first ready server is fine for a brand-new app, and scale-up uses
    // pickTargetServer to spread further replicas.
    const existingReady = db.getServers().find((s: Server) => s.status === "ready");
    if (existingReady) {
      serverIp = existingReady.ipv4;
      serverHostKey = existingReady.ssh_host_key || "";
      serverId = existingReady.id;
      state.dbServerId = existingReady.id;
      log("server", `Reusing existing ready server: ${existingReady.name} ip=${serverIp}`);
      onProgress("server", `Using server ${existingReady.name} (${serverIp})`);
    } else {
      const compute = getComputeProvider();
      onProgress("server", `Creating new ${compute.name} server...`);

      log("ssh", "Ensuring SSH key, firewall, and private network exist...");
      const { publicKey } = await getOrCreateLocalKeyPair();
      const [sshKey, firewallId, networkId] = await Promise.all([
        compute.ensureSshKey("one-click-deploy", publicKey),
        compute.ensureFirewall(),
        ensureSharedNetwork(),
      ]);
      log("ssh", `SSH key ready: ${sshKey.name}, firewall: ${firewallId}, network: ${networkId || "(none)"}`);
      onProgress("server", `SSH key + firewall + network ready`);

      const serverType = settings.default_server_type;
      if (!serverType) throw new Error("No default server type configured — set one in Settings");
      const location = settings.default_location;
      if (!location) throw new Error("No default server location configured — set one in Settings");
      const serverName = `ocd-${req.app_name}-${Date.now()}`;

      // Insert placeholder DB record BEFORE provider API call to prevent orphans
      const dbServer = db.insertServer({
        name: serverName,
        provider_id: "",
        provider: compute.id,
        ipv4: "",
        ipv6: "",
        type: serverType,
        location,
        status: "creating",
      });
      serverId = dbServer.id;
      state.dbServerId = dbServer.id;

      log("server", `Creating ${compute.name} server: name=${serverName} type=${serverType} location=${location}`);
      const createStart = Date.now();
      const providerServer = await compute.createServer({
        name: serverName,
        serverType,
        location,
        sshKeyName: sshKey.name,
        firewallId,
        networkId: networkId || undefined,
        userData: "",
      });
      state.providerServerId = providerServer.providerId;
      log("server", `Server created in ${Date.now() - createStart}ms: id=${providerServer.providerId} private=${providerServer.privateIpv4 || "(none)"}`);

      // Update placeholder with real data
      serverIp = providerServer.ipv4;
      db.updateServer(dbServer.id, {
        provider_id: providerServer.providerId,
        ipv4: serverIp,
        ipv6: providerServer.ipv6 || "",
        private_ipv4: providerServer.privateIpv4 || "",
        status: "provisioning",
      });
      log("server", `Server saved to DB: id=${dbServer.id}`);
      onProgress("server", `Server created: ${serverName} (${serverIp})`);

      // Wait for server VM to boot before attempting SSH
      onProgress("provision", "Waiting for server to boot...");
      await compute.waitForRunning(providerServer.providerId, (msg) => {
        onProgress("provision", msg);
      });

      // Wait for cloud-init provisioning
      onProgress("provision", "Waiting for server to be ready...");
      log("provision", `Waiting for server ${serverIp} to be provisioned...`);
      const provisionStart = Date.now();
      await waitForServer(serverIp, 30, (msg) => {
        onProgress("provision", msg);
      });
      log("provision", `Server provisioned in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`);

      // Verify docker is actually installed
      const dockerCheck = await sshExec(serverIp, "docker --version");
      if (dockerCheck.exitCode !== 0) {
        const initLog = await sshExec(serverIp, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
        log("provision", `Docker not found. Cloud-init log:\n${initLog.stdout}`);
        throw new Error("Server provisioned but Docker was not installed — server setup may have failed. Try deleting the server and deploying again.");
      }
      log("provision", `Docker verified: ${dockerCheck.stdout.trim()}`);

      // Capture SSH host key for future verification
      serverHostKey = await captureHostKey(serverIp);
      if (serverHostKey) {
        db.updateServerHostKey(dbServer.id, serverHostKey);
        log("provision", "SSH host key captured and stored");
      }

      db.updateServerStatus(dbServer.id, "ready");
      onProgress("provision", "Server provisioned with Docker + Caddy");
    }

    // Step 2: Determine domain + create DNS record.
    //
    // Caddy ingress now lives on the panel server, so every app's public DNS
    // record points at the panel's public IPv4 rather than the tenant's.
    // When no panel exists (pre-bootstrap), fall back to the tenant server
    // IP as before.
    const panel = db.getPanel();
    const panelServerRow = panel ? db.getServer(panel.server_id) : null;
    const ingressIp = panelServerRow?.ipv4 || serverIp;

    const useDomain = req.domain || `${req.app_name}.${ingressIp}.nip.io`;
    const useInternalTls = !req.domain;
    log("dns", `Domain: ${useDomain} (internal TLS: ${useInternalTls}) ingress=${ingressIp}`);

    onProgress("dns", req.domain ? `Creating DNS record for ${req.domain}...` : `Using ${useDomain} (no custom domain)`);
    const dnsZoneId = settings.dns_zone_id;

    // Extract subdomain from full domain
    const parts = useDomain.split(".");
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

    if (req.domain && dnsZoneId) {
      try {
        log("dns", `Creating DNS A record: ${subdomain} -> ${ingressIp} in zone ${dnsZoneId}`);
        const dns = getDnsProvider();
        const record = await dns.createRecord({
          zoneId: dnsZoneId,
          name: subdomain,
          type: "A",
          value: ingressIp,
        });
        state.dnsRecord = { zone_id: dnsZoneId, name: subdomain, type: "A", value: ingressIp };
        log("dns", `DNS record created: ${record.id}`);
        onProgress("dns", `DNS A record created: ${req.domain} -> ${ingressIp}`);
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
      const compute = getComputeProvider();
      if (!compute.volumes) throw new Error(`Provider "${compute.name}" does not support managed volumes`);

      // Get the provider server ID (either from new server or existing)
      let providerServerId: string;
      if (state.providerServerId) {
        providerServerId = state.providerServerId;
      } else {
        const existingServer = db.getServer(serverId!);
        if (!existingServer) throw new Error(`Server ${serverId} not found`);
        providerServerId = existingServer.provider_id;
      }

      onProgress("build", `Creating ${req.volume_size}GB persistent volume...`);
      const vol = await compute.volumes.create({
        name: `ocd-${req.app_name}-data`,
        sizeGb: req.volume_size,
        serverId: providerServerId,
        location: settings.default_location || "nbg1",
      });
      state.volumeId = vol.providerId;
      const hostMountPath = `/mnt/ocd-${req.app_name}-data`;
      const containerPath = req.volume_path || "/data";
      await sshExec(serverIp, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, serverHostKey || undefined);
      volumeMount = `${hostMountPath}:${containerPath}`;
      log("build", `Volume mounted: ${volumeMount}`);
      onProgress("build", `Volume ready (${req.volume_size}GB at /data)`);
    }

    // Step 4: Create app record, then clone & build
    onProgress("build", `Cloning ${req.git_repo} and building...`);

    let dockerfilePath = req.dockerfile_path || "Dockerfile";

    // Resolve or create the environment for this app
    let environmentId: number | undefined = req.environment_id;
    const flatEnvVars: Record<string, string> = {};

    if (environmentId) {
      // Use existing environment — resolve its vars for the build
      const envRow = db.getEnvironment(environmentId);
      if (envRow) {
        const { resolveEnvVarsForDeploy } = await import("../env-crypto.ts");
        Object.assign(flatEnvVars, await resolveEnvVarsForDeploy(envRow.env_vars));
      }
    } else if (req.env_vars && (Array.isArray(req.env_vars) ? req.env_vars.length > 0 : Object.keys(req.env_vars).length > 0)) {
      // Auto-create environment named after the app
      const processedEnv = await processIncomingEnvVars(req.env_vars);
      // Build flat env vars from raw input (secrets have plaintext in incoming data)
      const rawEntries = Array.isArray(req.env_vars)
        ? req.env_vars
        : Object.entries(req.env_vars).map(([k, v]) => ({ key: k, value: v as string }));
      for (const e of rawEntries) {
        flatEnvVars[e.key] = e.value;
      }
      // Find unique environment name
      let envName = req.app_name;
      let suffix = 1;
      while (db.getEnvironments().find((e) => e.name === envName)) {
        envName = `${req.app_name}-${suffix++}`;
      }
      const envRow = db.insertEnvironment(envName, serializeEnvVars(processedEnv.entries));
      environmentId = envRow.id;
    }

    const { app, replica } = db.insertAppWithFirstReplica(
      {
        name: req.app_name,
        domain: useDomain,
        git_repo: req.git_repo,
        dockerfile_path: dockerfilePath,
        docker_context: req.docker_context,
        container_port: req.container_port,
        env_vars: serializeEnvVars([]),
        auth_password: req.auth_password,
        environment_id: environmentId,
        public: req.public,
      },
      serverId!,
    );
    state.dbAppId = app.id;
    state.replicaId = replica.id;
    state.containerName = req.app_name;
    if (userId) db.updateAppDeployedBy(app.id, userId);
    log("build", `App + first replica created: app=${app.id} replica=${replica.id} host_port=${replica.host_port}`);

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
        await sshExec(serverIp, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps`);
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
        return await detectComposeFile(serverIp, req.app_name, serverHostKey || undefined);
      })();

      if (detected) {
        deployMode = "compose";
        composeFile = detected;
        composeWebService = req.compose_web_service ||
          await detectWebService(serverIp, req.app_name, detected, serverHostKey || undefined) ||
          "web";
        log("build", `Compose mode detected: file=${composeFile} service=${composeWebService}`);
      }
    }

    state.deployMode = deployMode;
    let buildImageTag = `${req.app_name}:latest`; // default, overridden by Dockerfile builds

    // Bind replica containers on the server's private IPv4. Traffic only
    // traverses the Hetzner private network between the panel's Caddy and
    // the backends; the public NIC never sees these host ports. Throws if
    // the server isn't yet attached to `ocd-net` — deploys that race the
    // network reconciler fail fast instead of silently publishing wide.
    const tenantServerRow = db.getServer(serverId!);
    if (!tenantServerRow) throw new Error(`Server ${serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    if (deployMode === "compose") {
      const result = await cloneAndComposeBuild(
        serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          hostPort: replica.host_port,
          envVars: flatEnvVars,
          volumeMount,
          composeFile,
          webService: composeWebService,
          gitToken: githubPat,
          bindAddr: containerBindAddr,
        },
        (line) => {
          maskedLog(app.id, `[build] ${line}`);
          onProgress("build", mask(line));
        }
      );
      db.updateAppDeployMode(app.id, "compose", result.composeFile, result.webService);
    } else {
      const result = await cloneAndBuild(
        serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          hostPort: replica.host_port,
          envVars: flatEnvVars,
          volumeMount,
          dockerfilePath: req.dockerfile_path,
          dockerContext: req.docker_context,
          gitToken: githubPat,
          bindAddr: containerBindAddr,
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
    let caddyPort = replica.host_port;
    if (req.auth_password) {
      onProgress("build", "Deploying auth proxy...");
      caddyPort = await deployAuthProxy(serverIp, req.app_name, req.auth_password, replica.host_port, containerBindAddr, serverHostKey || undefined);
      maskedLog(app.id, `[auth] Auth proxy deployed on port ${caddyPort}`);
    }

    // Step 5: Configure Caddy reverse proxy on the panel server.
    //
    // DNS preflight: if the user supplied a custom domain and we didn't
    // manage the record ourselves, verify it resolves to the *panel*
    // ingress IP. The panel owns TLS termination for every app now, so the
    // ACME HTTP-01 challenge lands on the panel's :80 listener — mismatched
    // DNS makes Let's Encrypt fail and visitors hit the wrong host entirely.
    if (req.domain && !useInternalTls && !state.dnsRecord) {
      onProgress("caddy", `Verifying DNS for ${req.domain}...`);
      const resolved = await resolveDomainIps(req.domain);
      if (resolved.length === 0) {
        throw new Error(
          `DNS lookup for ${req.domain} returned no A records. Create an A record pointing to ${ingressIp} and retry (DNS can take a few minutes to propagate).`
        );
      }
      if (!resolved.includes(ingressIp)) {
        throw new Error(
          `Domain ${req.domain} resolves to ${resolved.join(", ")} but the ingress server is ${ingressIp}. Update the A record to ${ingressIp} (Let's Encrypt will fail to issue a certificate otherwise) and retry.`
        );
      }
      onProgress("caddy", `DNS OK: ${req.domain} -> ${ingressIp}`);
    }

    // caddyPort is read for its side-effect (the auth proxy deploy above
    // already returned the right upstream port). The Caddy manager re-derives
    // upstream ports from the replica row, so nothing else needs to consume
    // this value here.
    void caddyPort;

    onProgress("caddy", `Configuring panel Caddy for ${useDomain}...`);
    await syncAppCaddy(app.id);
    state.caddyConfigured = true;
    state.caddyDomain = useDomain;
    state.appName = app.name;
    maskedLog(app.id, `[caddy] Panel ingress configured for ${useDomain}`);
    onProgress("caddy", useInternalTls ? "Caddy configured with self-signed TLS" : "Caddy configured with auto-TLS");

    // Step 5: Health check
    onProgress("health", "Checking app health...");
    const health = deployMode === "compose"
      ? await composeHealthCheck(serverIp, req.app_name, containerBindAddr, replica.host_port, 5, serverHostKey || undefined)
      : await healthCheck(serverIp, req.app_name, containerBindAddr, replica.host_port, 5, serverHostKey || undefined);
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
    const gitCommitResult = await sshExec(
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

    // Set up webhook for auto-redeploy if requested.
    // Phase 2: panel-routed webhooks. DB + GitHub API only — no SSH, no
    // tenant Caddy route. Hard error if panel.domain is missing.
    if (req.webhook_enabled && githubPat) {
      try {
        const panel = db.getPanel();
        if (!panel?.domain) {
          throw new Error("Panel domain is not set; cannot register webhook URL");
        }
        const webhookBranch = req.webhook_branch || "main";
        const webhookPath = (req.webhook_path || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
        const webhookSecret = crypto.randomUUID();
        const url = `https://${panel.domain}/webhooks/github/${app.id}`;
        const created = await github.createWebhookAtUrl({
          gitRepo: req.git_repo,
          url,
          webhookSecret,
          token: githubPat,
        });
        db.updateAppWebhook(app.id, true, webhookSecret, webhookBranch, String(created.id), webhookPath, !!req.webhook_wait_for_ci);
        const filterDesc = webhookPath ? ` (path: ${webhookPath})` : "";
        maskedLog(app.id, `[webhook] Auto-redeploy enabled on branch ${webhookBranch}${filterDesc}`);
        onProgress("health", `Webhook configured for auto-redeploy on ${webhookBranch}${filterDesc}`);
      } catch (err) {
        const webhookErr = err instanceof Error ? err.message : String(err);
        maskedLog(app.id, `[webhook] Warning: failed to set up webhook: ${webhookErr}`);
        log("webhook", `Webhook setup failed (non-fatal): ${webhookErr}`);
      }
    }

    // Mark the (already-created) first replica as healthy/unhealthy.
    db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

    // Scale up if replicas > 1 requested (only with a custom domain)
    if (req.replicas && req.replicas > 1 && req.domain) {
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
