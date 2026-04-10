import type { DeployRequest } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import * as github from "../github.ts";
import { validateDeployRequest } from "../validate.ts";
import { createMasker } from "../mask.ts";
import { getTokens } from "../secret-store.ts";
import { resolveGitHubToken } from "../github-token.ts";
import { scaleApp } from "../scale.ts";
import { type DeployState, rollback } from "./rollback.ts";
import { setupDns, verifyDnsForCaddy, persistDnsRecord } from "./dns.ts";
import { provisionOrReuseServer, createVolume } from "./provision.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

async function sshExecForDetection(ip: string, cmd: string) {
  try {
    return await hetzner.sshExec(ip, cmd);
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

async function detectDeployMode(
  req: DeployRequest,
  serverIp: string,
  serverHostKey: string,
  githubPat: string | undefined,
): Promise<{ deployMode: "dockerfile" | "compose"; composeFile: string; composeWebService: string }> {
  if (req.dockerfile_path) {
    return { deployMode: "dockerfile", composeFile: "", composeWebService: "" };
  }

  const detected = req.compose_file || await (async () => {
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
    const composeFile = detected;
    const composeWebService = req.compose_web_service ||
      await hetzner.detectWebService(serverIp, req.app_name, detected, serverHostKey || undefined) ||
      "web";
    log("build", `Compose mode detected: file=${composeFile} service=${composeWebService}`);
    return { deployMode: "compose", composeFile, composeWebService };
  }

  return { deployMode: "dockerfile", composeFile: "", composeWebService: "" };
}

async function buildAndRun(
  req: DeployRequest,
  serverIp: string,
  serverHostKey: string,
  replica: { host_port: number },
  appId: number,
  deployMode: "dockerfile" | "compose",
  composeFile: string,
  composeWebService: string,
  volumeMount: string | undefined,
  githubPat: string | undefined,
  maskedLog: (appId: number, line: string) => void,
  mask: (s: string) => string,
  onProgress: ProgressFn,
): Promise<{ dockerfilePath: string; buildImageTag: string }> {
  let dockerfilePath = req.dockerfile_path || "Dockerfile";
  let buildImageTag = `${req.app_name}:latest`;

  if (deployMode === "compose") {
    const result = await hetzner.cloneAndComposeBuild(
      serverIp,
      {
        name: req.app_name,
        gitRepo: req.git_repo,
        port: req.container_port,
        hostPort: replica.host_port,
        envVars: req.env_vars,
        volumeMount,
        composeFile,
        webService: composeWebService,
        gitToken: githubPat,
      },
      (line) => {
        maskedLog(appId, `[build] ${line}`);
        onProgress("build", mask(line));
      }
    );
    db.updateAppDeployMode(appId, "compose", result.composeFile, result.webService);
  } else {
    const result = await hetzner.cloneAndBuild(
      serverIp,
      {
        name: req.app_name,
        gitRepo: req.git_repo,
        port: req.container_port,
        hostPort: replica.host_port,
        envVars: req.env_vars,
        volumeMount,
        dockerfilePath: req.dockerfile_path,
        gitToken: githubPat,
      },
      (line) => {
        maskedLog(appId, `[build] ${line}`);
        onProgress("build", mask(line));
      }
    );
    dockerfilePath = result.dockerfilePath;
    if (result.imageTag) {
      buildImageTag = result.imageTag;
    }
  }

  return { dockerfilePath, buildImageTag };
}

async function setupWebhook(
  req: DeployRequest,
  appId: number,
  githubPat: string,
  maskedLog: (appId: number, line: string) => void,
  onProgress: ProgressFn,
): Promise<void> {
  try {
    const panel = db.getPanel();
    if (!panel?.domain) {
      throw new Error("Panel domain is not set; cannot register webhook URL");
    }
    const webhookBranch = req.webhook_branch || "main";
    const webhookPath = (req.webhook_path || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const webhookSecret = crypto.randomUUID();
    const url = `https://${panel.domain}/webhooks/github/${appId}`;
    const created = await github.createWebhookAtUrl({
      gitRepo: req.git_repo,
      url,
      webhookSecret,
      token: githubPat,
    });
    db.updateAppWebhook(appId, true, webhookSecret, webhookBranch, String(created.id), webhookPath);
    const filterDesc = webhookPath ? ` (path: ${webhookPath})` : "";
    maskedLog(appId, `[webhook] Auto-redeploy enabled on branch ${webhookBranch}${filterDesc}`);
    onProgress("health", `Webhook configured for auto-redeploy on ${webhookBranch}${filterDesc}`);
  } catch (err) {
    const webhookErr = err instanceof Error ? err.message : String(err);
    maskedLog(appId, `[webhook] Warning: failed to set up webhook: ${webhookErr}`);
    log("webhook", `Webhook setup failed (non-fatal): ${webhookErr}`);
  }
}

export async function deploy(
  req: DeployRequest,
  onProgress: ProgressFn,
  userId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const deployStart = Date.now();
  log("start", "Deploy request:", { app_name: req.app_name, git_repo: req.git_repo, domain: req.domain, container_port: req.container_port });

  const validation = validateDeployRequest(req);
  if (!validation.valid) {
    log("validation", `Failed: ${validation.error}`);
    return { ok: false, error: validation.error };
  }

  const existing = db.getAppByName(req.app_name);
  if (existing) {
    return { ok: false, error: `An app named "${req.app_name}" already exists. Choose a different name.` };
  }

  const tokens = await getTokens();
  const resolvedGitToken = await resolveGitHubToken(userId);
  const githubPat = resolvedGitToken || undefined;
  log("deploy", `GitHub token ${githubPat ? `present (${githubPat.length} chars)` : "not configured (user has no linked GitHub)"}`);
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

    // Step 1: Provision or reuse server
    const serverInfo = await provisionOrReuseServer(req.app_name, settings, state, onProgress);
    serverIp = serverInfo.serverIp;
    serverHostKey = serverInfo.serverHostKey;
    const serverId = serverInfo.serverId;

    // Step 2: Determine domain + create DNS record
    const { useDomain, useInternalTls } = await setupDns(req, serverIp, settings.dns_zone_id, state, onProgress);

    // Step 3: Create volume if requested
    let volumeMount: string | undefined;
    if (req.volume_size && req.volume_size > 0) {
      volumeMount = await createVolume(
        req.app_name,
        req.volume_size,
        req.volume_path,
        serverId,
        state.hetznerServerId,
        serverIp,
        serverHostKey,
        settings.default_location,
        state,
        onProgress,
      );
    }

    // Step 4: Create app record, then clone & build
    onProgress("build", `Cloning ${req.git_repo} and building...`);

    let dockerfilePath = req.dockerfile_path || "Dockerfile";
    const { app, replica } = db.insertAppWithFirstReplica(
      {
        name: req.app_name,
        domain: useDomain,
        git_repo: req.git_repo,
        dockerfile_path: dockerfilePath,
        container_port: req.container_port,
        env_vars: JSON.stringify(req.env_vars),
        auth_password: req.auth_password,
      },
      serverId,
    );
    state.dbAppId = app.id;
    state.replicaId = replica.id;
    state.containerName = req.app_name;
    if (userId) db.updateAppDeployedBy(app.id, userId);
    log("build", `App + first replica created: app=${app.id} replica=${replica.id} host_port=${replica.host_port}`);

    if (state.dnsRecord) {
      persistDnsRecord(app.id, state.dnsRecord);
    }

    if (state.volumeId && volumeMount) {
      db.updateAppVolume(app.id, state.volumeId, volumeMount);
    }

    const buildStart = Date.now();
    const { deployMode, composeFile, composeWebService } = await detectDeployMode(req, serverIp, serverHostKey, githubPat);
    state.deployMode = deployMode;

    const buildResult = await buildAndRun(
      req, serverIp, serverHostKey, replica, app.id,
      deployMode, composeFile, composeWebService,
      volumeMount, githubPat, maskedLog, mask, onProgress,
    );
    dockerfilePath = buildResult.dockerfilePath;
    const buildImageTag = buildResult.buildImageTag;

    log("build", `Clone & build completed in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
    onProgress("build", "Container running");

    // Step 4b: Deploy auth proxy if password protection is enabled
    let caddyPort = replica.host_port;
    if (req.auth_password) {
      onProgress("build", "Deploying auth proxy...");
      caddyPort = await hetzner.deployAuthProxy(serverIp, req.app_name, req.auth_password, replica.host_port, serverHostKey || undefined);
      maskedLog(app.id, `[auth] Auth proxy deployed on port ${caddyPort}`);
    }

    // Step 5: Configure Caddy reverse proxy
    if (req.domain && !useInternalTls && !state.dnsRecord) {
      await verifyDnsForCaddy(req.domain, serverIp, onProgress);
    }

    onProgress("caddy", `Configuring TLS + reverse proxy for ${useDomain}...`);
    await hetzner.deployCaddySite(serverIp, useDomain, caddyPort, useInternalTls, serverHostKey || undefined);
    state.caddyConfigured = true;
    state.caddyDomain = useDomain;
    maskedLog(app.id, `[caddy] Reverse proxy configured for ${useDomain}`);
    onProgress("caddy", useInternalTls ? "Caddy configured with self-signed TLS" : "Caddy configured with auto-TLS");

    // Step 6: Health check
    onProgress("health", "Checking app health...");
    const health = deployMode === "compose"
      ? await hetzner.composeHealthCheck(serverIp, req.app_name, replica.host_port, 5, serverHostKey || undefined)
      : await hetzner.healthCheck(serverIp, req.app_name, replica.host_port, 5, serverHostKey || undefined);
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
      await setupWebhook(req, app.id, githubPat, maskedLog, onProgress);
    }

    // Mark the first replica as healthy/unhealthy
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

    try {
      await rollback(state, serverIp, serverHostKey || undefined);
    } catch (rollbackErr) {
      log("error", "Rollback also failed:", rollbackErr);
    }

    onProgress("error", mask(msg));
    return { ok: false, error: mask(msg) };
  }
}
