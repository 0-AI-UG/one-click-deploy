import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { sshExec, getSshKeyPath } from "./ssh.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

type CaddyHandler = {
  handler: string;
  upstreams?: Array<{ dial: string }>;
  status_code?: string;
  headers?: Record<string, string[]>;
  body?: string;
  flush_interval?: number;
  transport?: Record<string, unknown>;
};

type CaddyRoute = {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: CaddyHandler[];
  terminal: boolean;
};

type CaddyTlsPolicy = {
  automation?: {
    policies: Array<{
      subjects: string[];
      issuers: Array<{ module: string }>;
    }>;
  };
};

type ComposeOverrideServices = {
  [service: string]: {
    ports?: string[];
    volumes?: string[];
    environment?: Record<string, string>;
  };
};

// --- Disk Cleanup ---

/**
 * Prune dangling Docker images and trim the git repo after a successful build.
 * Runs in the background (fire-and-forget) so it doesn't slow down deploys.
 */
export function pruneAfterBuild(ip: string, appName: string, hostKey?: string) {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const appDir = `/home/deploy/apps/${appName}`;

  // Remove old commit-tagged images for this app (keep only :latest which the
  // running container uses), prune dangling images, and compact the git repo.
  const cmd = [
    // Remove all tags for this app except :latest — old commit tags are no
    // longer needed since rollback rebuilds from git.
    `docker images ${appName} --format '{{.Repository}}:{{.Tag}}' | grep -v ':latest$' | xargs -r docker rmi 2>/dev/null || true`,
    // Prune dangling images (untagged layers from previous builds)
    `docker image prune -f`,
    // Compact the git repo
    `cd ${appDir} && git gc --auto 2>/dev/null || true`,
  ].join(" && ");

  sshExec(ip, asUser(cmd), hostKey).catch((err) => {
    log("prune", `Post-build cleanup on ${ip} failed (non-fatal): ${err}`);
  });
}

/**
 * Aggressive disk cleanup for a server: remove stopped containers, ALL unused
 * images (not just dangling), unused networks, and build cache.
 * Called periodically by the reconciler.
 */
export async function pruneServer(ip: string, hostKey?: string) {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  // --all removes ALL images not referenced by a running container (not just
  // dangling ones). This catches old tagged images that `docker image prune`
  // and the default `docker system prune` miss entirely.
  const result = await sshExec(
    ip,
    asUser(`docker system prune --all -f 2>&1 | tail -1`),
    hostKey,
  );
  if (result.stdout.trim()) {
    log("prune", `Server ${ip}: ${result.stdout.trim()}`);
  }
}

// --- Image Transfer ---

export async function transferImage(
  sourceIp: string,
  targetIp: string,
  imageName: string,
  sourceHostKey?: string,
  targetHostKey?: string
): Promise<void> {
  log("transfer", `Transferring image ${imageName} from ${sourceIp} to ${targetIp}`);
  const keyPath = getSshKeyPath();
  const ts = Date.now();
  const tmpFile = `/tmp/ocd-image-${ts}.tar.gz`;
  const localTmp = `${tmpdir()}/ocd-image-transfer-${ts}.tar.gz`;

  try {
    // Save and compress on source (as deploy user who owns docker)
    const saveResult = await sshExec(
      sourceIp,
      `su - deploy -c "docker save ${imageName} | gzip" > ${tmpFile}`,
      sourceHostKey
    );
    if (saveResult.exitCode !== 0) {
      throw new Error("Failed to export Docker image from source server");
    }

    // Download to local
    const scpDown = Bun.spawn([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      `root@${sourceIp}:${tmpFile}`,
      localTmp,
    ], { stdout: "pipe", stderr: "pipe" });
    const downExit = await scpDown.exited;
    if (downExit !== 0) {
      const stderr = await new Response(scpDown.stderr).text();
      throw new Error("Failed to download image from source server — check SSH connectivity");
    }

    // Upload to target
    const scpUp = Bun.spawn([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      localTmp,
      `root@${targetIp}:${tmpFile}`,
    ], { stdout: "pipe", stderr: "pipe" });
    const upExit = await scpUp.exited;
    if (upExit !== 0) {
      const stderr = await new Response(scpUp.stderr).text();
      throw new Error("Failed to upload image to target server — check SSH connectivity");
    }

    // Load on target — run docker load as deploy, but file is owned by root
    // So: gunzip as root, pipe to deploy's docker load
    const loadResult = await sshExec(
      targetIp,
      `gunzip -c ${tmpFile} | su - deploy -c "docker load"`,
      targetHostKey
    );
    if (loadResult.exitCode !== 0) {
      throw new Error("Failed to import Docker image on target server");
    }

    log("transfer", `Image ${imageName} transferred successfully`);
  } finally {
    // Cleanup remote temp files (as root, which owns them)
    await sshExec(sourceIp, `rm -f ${tmpFile}`, sourceHostKey).catch(() => { /* non-fatal cleanup */ });
    await sshExec(targetIp, `rm -f ${tmpFile}`, targetHostKey).catch(() => { /* non-fatal cleanup */ });
    try { unlinkSync(localTmp); } catch { /* file may already be gone */ }
  }
}

// --- Caddy Sites ---

/** Persist the live Caddy config to disk so it survives restarts. */
async function persistCaddyConfig(ip: string, hostKey?: string) {
  const result = await sshExec(
    ip,
    `curl -sf http://localhost:2019/config/ | tee /etc/caddy/caddy.json > /dev/null`,
    hostKey
  );
  if (result.exitCode !== 0) {
    log("caddy", "Warning: failed to persist Caddy config to disk");
  }
}

export async function deployCaddySite(
  ip: string,
  domain: string,
  containerPort: number,
  internalTls: boolean = false,
  hostKey?: string
) {
  log("caddy", `Deploying site via admin API: domain=${domain} port=${containerPort} internalTls=${internalTls}`);

  // Build the Caddy JSON config for this route
  const routeId = `ocd-${domain.replace(/\./g, "-")}`;
  const handler: CaddyHandler = {
    handler: "reverse_proxy",
    upstreams: [{ dial: `localhost:${containerPort}` }],
    // flush_interval -1 ensures streaming/WebSocket data is forwarded
    // immediately instead of being buffered.
    flush_interval: -1,
    transport: {
      protocol: "http",
      // Keep upstream connections alive so WebSocket upgrades aren't dropped
      // by stale TCP teardowns between Caddy and the backend.
      keep_alive: {
        enabled: true,
        idle_conns_per_host: 16,
        max_idle_conns_per_host: 32,
      },
    },
  };

  const route: CaddyRoute = {
    "@id": routeId,
    match: [{ host: [domain] }],
    handle: [
      {
        handler: "headers",
        response: {
          set: {
            "X-Content-Type-Options": ["nosniff"],
            "X-Frame-Options": ["DENY"],
            "Referrer-Policy": ["strict-origin-when-cross-origin"],
            "X-XSS-Protection": ["1; mode=block"],
          },
          deferred: true,
        },
      } as CaddyHandler,
      handler,
    ],
    terminal: true,
  };

  const tlsPolicy: CaddyTlsPolicy = internalTls
    ? { automation: { policies: [{ subjects: [domain], issuers: [{ module: "internal" }] }] } }
    : {};

  // Try to delete existing route first (ignore errors if not found)
  await sshExec(
    ip,
    `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`,
    hostKey
  );

  // Add the route via the admin API
  const routeJson = JSON.stringify(route);
  const escaped = routeJson.replace(/'/g, "'\\''");
  const addResult = await sshExec(
    ip,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${escaped}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
    hostKey
  );

  if (addResult.exitCode !== 0) {
    log("caddy", `Admin API route add failed: ${addResult.stderr}. Restarting Caddy and retrying...`);
    // Restart Caddy (loads persisted caddy.json from disk) and retry
    await sshExec(ip, "systemctl restart caddy", hostKey);
    await Bun.sleep(1000);
    // Re-delete in case the route survived the restart
    await sshExec(ip, `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`, hostKey);
    const retry = await sshExec(
      ip,
      `curl -sf -X POST -H 'Content-Type: application/json' -d '${escaped}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
      hostKey
    );
    if (retry.exitCode !== 0) {
      log("caddy", `Admin API retry also failed: ${retry.stderr}`);
      throw new Error("Failed to configure Caddy reverse proxy for " + domain);
    }
  }

  // If using internal TLS, set the TLS automation policy
  if (internalTls) {
    const tlsJson = JSON.stringify(tlsPolicy);
    const tlsEscaped = tlsJson.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `curl -sf -X PATCH -H 'Content-Type: application/json' -d '${tlsEscaped}' http://localhost:2019/config/apps/tls`,
      hostKey
    );
  }

  // Persist live config to disk so routes survive Caddy restarts
  await persistCaddyConfig(ip, hostKey);
  log("caddy", "Site configured via admin API (persisted to disk)");
}

/**
 * Build the HTML served by a Caddy wake-page route. The page hits
 * `/api/apps/{id}/wake?token=...` on the panel to trigger a background wake
 * and then polls `/api/apps/{id}/wake/status` until the app is running,
 * reloading the tab once it is.
 */
function wakePageHtml(panelOrigin: string, appId: number, wakeToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waking up...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.c{text-align:center}
.spinner{width:24px;height:24px;border:3px solid #333;border-top-color:#e5e5e5;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px}
p{font-size:11px;color:#888}
a{color:#888}
</style>
</head>
<body>
<div class="c">
<div class="spinner"></div>
<h1>Waking up</h1>
<p>This app is sleeping. Starting a container...</p>
<noscript><p style="margin-top:12px"><a href="${panelOrigin}">Open dashboard</a></p></noscript>
</div>
<script>
(function(){
  var P="${panelOrigin}",ID=${appId},T="${wakeToken}",n=0;
  if(!P)return;
  var h=document.querySelector("h1"),p=document.querySelector("p"),sp=document.querySelector(".spinner");
  function fail(msg){clearInterval(iv);if(sp)sp.style.display="none";h.textContent="Error";p.innerHTML=msg+' <a href="'+P+'">Open dashboard</a>';}
  fetch(P+"/api/apps/"+ID+"/wake?token="+T,{method:"POST",mode:"cors"}).catch(function(){});
  function tryReload(attempts){
    fetch(location.href,{method:"HEAD",cache:"no-store",redirect:"follow"}).then(function(r){
      if(r.status!==503){window.location.replace(location.href.split("?")[0]+"?_t="+Date.now())}
      else if(attempts>0){setTimeout(function(){tryReload(attempts-1)},1000)}
      else{window.location.replace(location.href.split("?")[0]+"?_t="+Date.now())}
    }).catch(function(){if(attempts>0){setTimeout(function(){tryReload(attempts-1)},1000)}else{location.reload()}});
  }
  var iv=setInterval(function(){
    if(++n>60){clearInterval(iv);if(sp)sp.style.display="none";h.textContent="Timeout";p.innerHTML='App did not wake within 2 minutes. <a href="'+P+'">Open dashboard</a>';return}
    fetch(P+"/api/apps/"+ID+"/wake-status?token="+T,{mode:"cors"})
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.status==="running"){clearInterval(iv);p.textContent="Ready! Reloading...";tryReload(10)}
        if(d.status==="error"){fail("App failed to start. ")}
      })
      .catch(function(){});
  },2000);
})();
</script>
</body>
</html>`;
}

/**
 * Build a static_response wake-page Caddy route that 503s with the HTML
 * above. Identical for the tenant-server and panel-server cases — only the
 * TLS policy differs, so policy handling is done by the callers.
 */
function wakePageRoute(
  domain: string,
  html: string,
  routeId: string,
): CaddyRoute {
  return {
    "@id": routeId,
    match: [{ host: [domain] }],
    handle: [
      {
        handler: "static_response",
        status_code: "503",
        headers: {
          "Content-Type": ["text/html; charset=utf-8"],
          "Cache-Control": ["no-store, no-cache, must-revalidate"],
          "Retry-After": ["30"],
        },
        body: html,
      },
    ],
    terminal: true,
  };
}

/**
 * Deploy a Caddy route that serves a "Waking up" HTML page for a sleeping app.
 * The page auto-triggers a wake request to the panel and polls until ready.
 */
export async function deployCaddyWakePage(
  ip: string,
  domain: string,
  panelDomain: string,
  appId: number,
  wakeToken: string,
  internalTls: boolean = false,
  hostKey?: string
) {
  log("caddy", `Deploying wake page: domain=${domain} appId=${appId}`);

  const routeId = `ocd-${domain.replace(/\./g, "-")}`;
  const panelOrigin = panelDomain ? `https://${panelDomain}` : "";
  const html = wakePageHtml(panelOrigin, appId, wakeToken);
  const route = wakePageRoute(domain, html, routeId);

  const tlsPolicy: CaddyTlsPolicy = internalTls
    ? { automation: { policies: [{ subjects: [domain], issuers: [{ module: "internal" }] }] } }
    : {};

  // Delete existing route first
  await sshExec(ip, `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`, hostKey);

  // Add the wake page route
  const routeJson = JSON.stringify(route);
  const escaped = routeJson.replace(/'/g, "'\\''");
  const addResult = await sshExec(
    ip,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${escaped}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
    hostKey
  );

  if (addResult.exitCode !== 0) {
    log("caddy", `Wake page route add failed: ${addResult.stderr}. Restarting Caddy and retrying...`);
    await sshExec(ip, "systemctl restart caddy", hostKey);
    await Bun.sleep(1000);
    await sshExec(ip, `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`, hostKey);
    const retry = await sshExec(
      ip,
      `curl -sf -X POST -H 'Content-Type: application/json' -d '${escaped}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
      hostKey
    );
    if (retry.exitCode !== 0) {
      throw new Error("Failed to configure Caddy wake page for " + domain);
    }
  }

  if (internalTls) {
    const tlsJson = JSON.stringify(tlsPolicy);
    const tlsEscaped = tlsJson.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `curl -sf -X PATCH -H 'Content-Type: application/json' -d '${tlsEscaped}' http://localhost:2019/config/apps/tls`,
      hostKey
    );
  }

  await persistCaddyConfig(ip, hostKey);
  log("caddy", "Wake page configured via admin API (persisted to disk)");
}

// --- Registry Auth ---

async function dockerLoginGhcr(
  ip: string,
  token: string,
  hostKey?: string,
): Promise<void> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const escaped = token.replace(/'/g, "'\\''");
  const result = await sshExec(
    ip,
    asUser(`echo '${escaped}' | docker login ghcr.io -u x-access-token --password-stdin`),
    hostKey,
  );
  if (result.exitCode !== 0) {
    log("registry", `ghcr.io login failed: ${result.stderr}`);
    throw new Error(
      "Failed to authenticate with GitHub Container Registry (ghcr.io). Check your GitHub token has the read:packages scope.",
    );
  }
  log("registry", "ghcr.io login succeeded");
}

// --- Clone & Build ---

// Shared git clone/pull logic used by both cloneAndBuild and cloneAndComposeBuild
async function cloneRepo(
  ip: string,
  appName: string,
  gitRepo: string,
  gitToken?: string,
  emit?: (msg: string) => void
) {
  const appDir = `/home/deploy/apps/${appName}`;
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  let cloneUrl = gitRepo;
  if (gitToken && cloneUrl.match(/^https:\/\/github\.com\//)) {
    cloneUrl = cloneUrl.replace(
      /^https:\/\/github\.com\//,
      `https://x-access-token:${gitToken}@github.com/`
    );
  }

  emit?.("Cloning repository...");
  log("build", `Cloning ${gitRepo} into ${appDir} (token: ${gitToken ? "yes" : "no"})`);
  // Ensure the app dir (if it exists) is owned by deploy so the subsequent
  // rm -rf/git clone/pull works even if a prior root-run step (e.g. scaleUp
  // writing .env.deploy) left root-owned files behind.
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps && mkdir -p ${appDir} && chown -R deploy:deploy ${appDir}`);
  const gitEnv = gitToken ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
  const cloneResult = await sshExec(
    ip,
    asUser(`${gitEnv}if [ -d "${appDir}/.git" ]; then cd ${appDir} && git remote set-url origin ${cloneUrl} && git pull; else rm -rf ${appDir} && git clone ${cloneUrl} ${appDir}; fi`)
  );
  if (cloneResult.exitCode !== 0) {
    const stderr = cloneResult.stderr;
    log("build", `Clone failed (exit=${cloneResult.exitCode}): ${stderr.slice(0, 800)}`);
    const notFound = stderr.match(/Repository not found/i);
    const isAuthError = stderr.match(/could not read Username|Authentication failed|403/i);
    if (notFound && gitToken) {
      throw new Error(`Git clone failed: repository not found. Check that the repo URL is correct and your GitHub token has access to it.`);
    }
    if ((isAuthError || notFound) && !gitToken) {
      throw new Error(`Git clone failed: repository requires authentication. Link your GitHub account in Account settings.`);
    }
    if (isAuthError && gitToken) {
      throw new Error(`Git clone failed: authentication rejected. Check that your GitHub token is valid and has the "repo" scope.`);
    }
    const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    throw new Error(`Git clone failed: ${detail || `exit ${cloneResult.exitCode} (no stderr)`}`);
  }

  // Strip token from git remote
  if (gitToken && cloneUrl !== gitRepo) {
    await sshExec(ip, asUser(`cd ${appDir} && git remote set-url origin ${gitRepo}`));
  }
  log("build", `Clone done, stdout: ${cloneResult.stdout.trim().slice(0, 200)}`);
}

export async function cloneAndBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number; // container port
    hostPort: number; // host-side port for docker binding
    envVars: Record<string, string>;
    volumeMount?: string; // e.g. "/mnt/data:/data" — host:container
    extraVolumes?: string[]; // additional -v mounts, e.g. ["/host:/container"]
    dockerfilePath?: string; // explicit path to Dockerfile in repo
    dockerContext?: string; // build context path relative to repo root, defaults to "."
    gitToken?: string; // GitHub PAT for private repos
    /** Host-side bind address for the published port. Defaults to 127.0.0.1
     *  so containers aren't exposed on the public interface. Pass the
     *  server's `private_ipv4` when the app is reached by the panel Caddy
     *  over the shared private network. */
    bindAddr?: string;
    /** Override for the docker container name. Defaults to `opts.name`.
     *  Needed when redeploying a replica whose container is named
     *  `${app}-r${n}` (from scaleUp/migrate) rather than bare `${app}`. */
    containerName?: string;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Clone or pull repo
  await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit);

  // Find Dockerfile
  let dockerfilePath = opts.dockerfilePath?.replace(/^\/+/, "");
  if (dockerfilePath) {
    emit(`Using specified Dockerfile: ${dockerfilePath}`);
    const checkResult = await sshExec(ip, asUser(`test -f ${appDir}/${dockerfilePath} && echo ok`));
    if (checkResult.stdout.trim() !== "ok") {
      throw new Error(`Dockerfile not found at "${dockerfilePath}" in the repository. The path should be relative to the repo root, e.g. "Dockerfile" or "docker/Dockerfile".`);
    }
    log("build", `Using specified Dockerfile: ${dockerfilePath}`);
  } else {
    emit("Searching for Dockerfile...");
    const findResult = await sshExec(
      ip,
      asUser(`cd ${appDir} && if [ -f Dockerfile ]; then echo Dockerfile; elif [ -f docker/Dockerfile ]; then echo docker/Dockerfile; else find . -maxdepth 3 -name Dockerfile -type f | head -1 | sed 's|^\\./||'; fi`)
    );
    dockerfilePath = findResult.stdout.trim();
    if (!dockerfilePath) {
      throw new Error("No Dockerfile found in repository");
    }
    log("build", `Found Dockerfile: ${dockerfilePath}`);
    emit(`Found Dockerfile at: ${dockerfilePath}`);
  }

  // Authenticate with ghcr.io if a GitHub token is available (needed for
  // private base images in FROM directives)
  if (opts.gitToken) {
    await dockerLoginGhcr(ip, opts.gitToken);
  }

  // Build image first (before stopping old container — build-before-destroy)
  emit("Building Docker image...");
  const dockerContext = opts.dockerContext || ".";
  const buildCmd = `cd ${appDir} && docker build -t ${opts.name}:latest -f ${dockerfilePath} ${dockerContext}`;
  log("build", `Docker build command: ${buildCmd}`);
  const dockerBuildStart = Date.now();
  const buildResult = await sshExec(ip, asUser(buildCmd));
  if (buildResult.exitCode !== 0) {
    log("build", `Docker build stderr: ${buildResult.stderr.slice(0, 500)}`);
    throw new Error("Docker build failed — check your Dockerfile and build logs for errors");
  }
  log("build", `Docker build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully");

  // Build succeeded — now safe to stop old container and swap
  const containerName = opts.containerName || opts.name;
  log("build", `Removing existing container ${containerName} (if any)`);
  await sshExec(ip, asUser(`docker rm -f ${containerName} 2>/dev/null || true`));

  // Write env file to server (avoids shell injection via env var values)
  const envFileEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envFileEntries.length > 0) {
    const envFilePath = `/home/deploy/apps/${opts.name}/.env.deploy`;
    const envFileContent = envFileEntries
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`);
    envFileFlag = `--env-file ${envFilePath}`;
  }

  // Run container
  emit("Starting container...");
  // Ensure ocd-net exists so apps can reach infrastructure services by container name
  await ensureOcdNetwork(ip);
  const volumeFlag = opts.volumeMount ? `-v ${opts.volumeMount}` : "";
  const extraVolFlags = (opts.extraVolumes || []).map((v) => `-v ${v}`).join(" ");
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const cmd = `docker run -d --name ${containerName} --restart unless-stopped --network ocd-net -p ${bindAddr}:${opts.hostPort}:${opts.port} ${envFileFlag} ${volumeFlag} ${extraVolFlags} ${opts.name}:latest`;
  log("build", `Docker run: ${cmd}`);
  const result = await sshExec(ip, asUser(cmd));
  if (result.exitCode !== 0) {
    log("build", `Docker run stderr: ${result.stderr}`);
    const detail = result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    throw new Error(`Failed to start container: ${detail || `exit ${result.exitCode}`}`);
  }
  log("build", `Container started: ${result.stdout.trim().slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name);

  return { containerId: result.stdout.trim(), dockerfilePath, imageTag: `${opts.name}:latest` };
}

// --- Railpack (zero-config) builds ---

/** Ensure the BuildKit container is running (needed by railpack). */
async function ensureBuildkit(ip: string, hostKey?: string) {
  const check = await sshExec(ip, `docker inspect -f '{{.State.Running}}' buildkit 2>/dev/null`, hostKey);
  if (check.stdout.trim() === "true") return;
  log("railpack", "Starting BuildKit container");
  await sshExec(ip, `docker rm -f buildkit 2>/dev/null; docker run --rm --privileged -d --name buildkit moby/buildkit`, hostKey);
  // Give BuildKit a moment to start its gRPC listener
  await sshExec(ip, `sleep 2`, hostKey);
}

export async function cloneAndRailpackBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number;
    hostPort: number;
    envVars: Record<string, string>;
    volumeMount?: string;
    extraVolumes?: string[];
    gitToken?: string;
    /** See `cloneAndBuild` — defaults to 127.0.0.1. */
    bindAddr?: string;
    /** See `cloneAndBuild` — defaults to `opts.name`. */
    containerName?: string;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const containerName = opts.containerName || opts.name;

  // Clone or pull repo
  await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit);

  // Ensure BuildKit is available
  await ensureBuildkit(ip);

  // Build image with Railpack
  emit("Building with Railpack (zero-config)...");
  const railpackCmd = `cd ${appDir} && BUILDKIT_HOST=docker-container://buildkit railpack build --name ${opts.name}:latest .`;
  log("railpack", `Railpack build command: ${railpackCmd}`);
  const dockerBuildStart = Date.now();
  const buildResult = await sshExec(ip, asUser(railpackCmd));
  if (buildResult.exitCode !== 0) {
    log("railpack", `Railpack build stderr: ${buildResult.stderr.slice(0, 500)}`);
    // Check if railpack is not installed
    if (buildResult.stderr.includes("not found") || buildResult.stderr.includes("No such file")) {
      throw new Error("Railpack is not installed on this server. It is available on newly provisioned servers — try deploying to a new server or install it manually (curl -sSL https://railpack.com/install.sh | sh).");
    }
    throw new Error("Railpack build failed — check the build logs for errors. You can also add a Dockerfile to your repo for more control.");
  }
  log("railpack", `Railpack build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully with Railpack");

  // Stop old container and swap
  log("railpack", `Removing existing container ${containerName} (if any)`);
  await sshExec(ip, asUser(`docker rm -f ${containerName} 2>/dev/null || true`));

  // Write env file
  const envFileEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envFileEntries.length > 0) {
    const envFilePath = `/home/deploy/apps/${opts.name}/.env.deploy`;
    const envFileContent = envFileEntries.map(([k, v]) => `${k}=${v}`).join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`);
    envFileFlag = `--env-file ${envFilePath}`;
  }

  // Run container
  emit("Starting container...");
  await ensureOcdNetwork(ip);
  const volumeFlag = opts.volumeMount ? `-v ${opts.volumeMount}` : "";
  const extraVolFlags = (opts.extraVolumes || []).map((v) => `-v ${v}`).join(" ");
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const cmd = `docker run -d --name ${containerName} --restart unless-stopped --network ocd-net -p ${bindAddr}:${opts.hostPort}:${opts.port} ${envFileFlag} ${volumeFlag} ${extraVolFlags} ${opts.name}:latest`;
  log("railpack", `Docker run: ${cmd}`);
  const result = await sshExec(ip, asUser(cmd));
  if (result.exitCode !== 0) {
    log("railpack", `Docker run stderr: ${result.stderr}`);
    const detail = result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    throw new Error(`Failed to start container: ${detail || `exit ${result.exitCode}`}`);
  }
  log("railpack", `Container started: ${result.stdout.trim().slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name);

  return { containerId: result.stdout.trim(), imageTag: `${opts.name}:latest` };
}

export async function removeContainer(ip: string, name: string, hostKey?: string) {
  await sshExec(ip, `su - deploy -c "docker rm -f ${name} 2>/dev/null || true"`, hostKey);
}

// --- Docker Compose Support ---

const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export async function detectComposeFile(
  ip: string,
  appName: string,
  hostKey?: string
): Promise<string | null> {
  const appDir = `/home/deploy/apps/${appName}`;
  const check = COMPOSE_FILE_NAMES.map((f) => `[ -f "${appDir}/${f}" ] && echo "${f}"`).join("; ");
  const result = await sshExec(ip, `su - deploy -c '${check}'`, hostKey);
  const found = result.stdout.trim().split("\n").filter(Boolean);
  return found.length > 0 ? found[0] : null;
}

export async function detectWebService(
  ip: string,
  appName: string,
  composeFile: string,
  hostKey?: string
): Promise<string | null> {
  const appDir = `/home/deploy/apps/${appName}`;
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Parse compose file to find the web-facing service
  const configResult = await sshExec(
    ip,
    asUser(`cd ${appDir} && docker compose -f ${composeFile} config --format json 2>/dev/null`),
    hostKey
  );
  if (configResult.exitCode !== 0 || !configResult.stdout.trim()) {
    return null;
  }

  try {
    const config = JSON.parse(configResult.stdout);
    const services = config.services || {};
    const serviceNames = Object.keys(services);
    if (serviceNames.length === 0) return null;

    // Prefer service with ports defined
    for (const name of serviceNames) {
      if (services[name].ports && services[name].ports.length > 0) {
        return name;
      }
    }

    // Fall back to well-known names
    const wellKnown = ["web", "app", "frontend", "server", "api"];
    for (const name of wellKnown) {
      if (serviceNames.includes(name)) return name;
    }

    // Fall back to first service
    return serviceNames[0];
  } catch {
    return null;
  }
}

export async function cloneAndComposeBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number; // container port (web service)
    hostPort: number; // host-side port for Caddy
    envVars: Record<string, string>;
    volumeMount?: string; // e.g. "/mnt/data:/data" — host:container
    extraVolumes?: string[]; // additional volume mounts
    composeFile: string; // e.g. "docker-compose.yml"
    webService: string; // e.g. "web"
    gitToken?: string;
    /** Host-side bind address for the web service's published port.
     *  Defaults to 127.0.0.1 for public-interface isolation. Pass the
     *  server's `private_ipv4` when the panel Caddy reaches this replica
     *  over the shared private network. */
    bindAddr?: string;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Clone or pull repo (shared with cloneAndBuild)
  await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit);

  // Note: No explicit "docker compose down" here — "docker compose up -d --build"
  // handles stopping old containers and replacing them atomically (build-before-destroy).

  // Generate override file for port mapping and volume
  emit("Generating compose override...");
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const overrideServices: ComposeOverrideServices = {
    [opts.webService]: {
      ports: [`${bindAddr}:${opts.hostPort}:${opts.port}`],
    },
  };
  const allVolumes = [
    ...(opts.volumeMount ? [opts.volumeMount] : []),
    ...(opts.extraVolumes || []),
  ];
  if (allVolumes.length > 0) {
    overrideServices[opts.webService].volumes = allVolumes;
  }
  const override = JSON.stringify({ services: overrideServices });
  const overridePath = `${appDir}/docker-compose.ocd.yml`;
  const escapedOverride = override.replace(/'/g, "'\\''");
  // Convert JSON to YAML-compatible format that docker compose can read
  // Docker compose accepts JSON as a valid YAML superset
  await sshExec(ip, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`);
  log("compose", `Override written to ${overridePath}`);

  // Write env file
  const envFileEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envFileEntries.length > 0) {
    const envFilePath = `${appDir}/.env.deploy`;
    const envFileContent = envFileEntries.map(([k, v]) => `${k}=${v}`).join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`);
    envFileFlag = `--env-file ${envFilePath}`;
  }

  // Authenticate with ghcr.io if a GitHub token is available (needed for
  // private GitHub Container Registry images referenced in compose files)
  if (opts.gitToken) {
    emit("Authenticating with GitHub Container Registry...");
    await dockerLoginGhcr(ip, opts.gitToken);
  }

  // Build and start compose project
  emit("Building and starting compose project...");
  const composeCmd = `cd ${appDir} && docker compose -f ${opts.composeFile} -f docker-compose.ocd.yml -p ${opts.name} ${envFileFlag} up -d --build`;
  log("compose", `Compose command: ${composeCmd}`);
  const buildResult = await sshExec(ip, asUser(composeCmd));
  if (buildResult.exitCode !== 0) {
    log("compose", `Compose build stderr: ${buildResult.stderr.slice(0, 500)}`);
    throw new Error("Docker Compose build failed — check your compose file and build logs for errors");
  }
  log("compose", `Compose project started in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
  emit("Compose project started");

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name);

  return { composeFile: opts.composeFile, webService: opts.webService };
}

// --- Compose Lifecycle Operations ---

export async function restartCompose(ip: string, projectName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} restart"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to restart compose project — check container logs for details");
  }
}

export async function pauseCompose(ip: string, projectName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} pause"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to pause compose project");
  }
}

export async function unpauseCompose(ip: string, projectName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} unpause"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to unpause compose project");
  }
}

export async function removeCompose(ip: string, projectName: string, removeVolumes = false, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const volFlag = removeVolumes ? " -v" : "";
  await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} down${volFlag} 2>/dev/null || true"`,
    hostKey
  );
}

export async function getComposeLogs(
  ip: string,
  projectName: string,
  tail: number = 100,
  hostKey?: string
): Promise<string> {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} logs --tail ${tail} 2>&1"`,
    hostKey
  );
  return result.stdout;
}

// --- Health Checks ---

export async function composeHealthCheck(
  ip: string,
  projectName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  log("health", `Checking compose health of ${projectName} on ${ip} via ${bindHost}:${port}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Check all services are running
    const appDir = `/home/deploy/apps/${projectName}`;
    const ps = await sshExec(
      ip,
      `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} ps --format json 2>/dev/null"`,
      hostKey
    );
    if (ps.exitCode !== 0) {
      if (i < maxAttempts - 1) {
        log("health", `Compose ps failed (attempt ${i + 1}/${maxAttempts})`);
        await Bun.sleep(3000);
        continue;
      }
      return { healthy: false, error: "Failed to check compose services" };
    }

    // Parse service statuses — docker compose ps --format json outputs one JSON per line
    const lines = ps.stdout.trim().split("\n").filter(Boolean);
    let allRunning = lines.length > 0;
    for (const line of lines) {
      try {
        const svc = JSON.parse(line);
        if (svc.State !== "running") {
          allRunning = false;
          break;
        }
      } catch {
        allRunning = false;
        break;
      }
    }

    if (!allRunning) {
      if (i < maxAttempts - 1) {
        log("health", `Not all compose services running yet (attempt ${i + 1}/${maxAttempts})`);
        await Bun.sleep(3000);
        continue;
      }
      return { healthy: false, error: "Not all compose services are running" };
    }

    // Check HTTP response on the web service's published port. `bindHost`
    // is the address the container's `-p` flag publishes on — usually the
    // server's private IPv4 for tenant apps, or 127.0.0.1 for the panel.
    const curl = await sshExec(
      ip,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${bindHost}:${port}/`,
      hostKey
    );
    const statusCode = parseInt(curl.stdout.trim(), 10);
    if (statusCode >= 200 && statusCode < 500) {
      log("health", `Compose health check passed: HTTP ${statusCode}`);
      return { healthy: true, statusCode };
    }

    if (i < maxAttempts - 1) {
      log("health", `Compose health check returned ${statusCode} (attempt ${i + 1}/${maxAttempts})`);
      await Bun.sleep(3000);
    } else {
      return {
        healthy: false,
        statusCode: isNaN(statusCode) ? undefined : statusCode,
        error: `Health check failed with HTTP ${statusCode || "no response"}`,
      };
    }
  }

  return { healthy: false, error: "Health check timed out" };
}

export async function healthCheck(
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  log("health", `Checking health of ${containerName} on ${ip} via ${bindHost}:${port}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Check container is running
    const inspect = await sshExec(
      ip,
      `su - deploy -c "docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null"`,
      hostKey
    );
    if (inspect.stdout.trim() !== "true") {
      if (i < maxAttempts - 1) {
        log("health", `Container not running yet (attempt ${i + 1}/${maxAttempts})`);
        await Bun.sleep(3000);
        continue;
      }
      return { healthy: false, error: "Container is not running" };
    }

    // Check HTTP response on the container's published port. `bindHost`
    // is whatever address the container is bound to — typically the
    // server's private IPv4 for tenant apps, 127.0.0.1 for the panel.
    const curl = await sshExec(
      ip,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${bindHost}:${port}/`,
      hostKey
    );
    const statusCode = parseInt(curl.stdout.trim(), 10);
    if (statusCode >= 200 && statusCode < 500) {
      log("health", `Health check passed: HTTP ${statusCode}`);
      return { healthy: true, statusCode };
    }

    if (i < maxAttempts - 1) {
      log("health", `Health check returned ${statusCode} (attempt ${i + 1}/${maxAttempts})`);
      await Bun.sleep(3000);
    } else {
      return {
        healthy: false,
        statusCode: isNaN(statusCode) ? undefined : statusCode,
        error: `Health check failed with HTTP ${statusCode || "no response"}`,
      };
    }
  }

  return { healthy: false, error: "Health check timed out" };
}

// --- Container Logs ---

export async function getContainerLogs(
  ip: string,
  containerName: string,
  tail: number = 100,
  hostKey?: string
): Promise<string> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker logs --tail ${tail} ${containerName} 2>&1"`,
    hostKey
  );
  return result.stdout;
}

// --- Container Restart / Pause / Unpause ---

export async function restartContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker restart ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to restart container — it may have crashed, check logs for details");
  }
}

export async function pauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker pause ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to pause container");
  }
}

export async function unpauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker unpause ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to unpause container");
  }
}

/**
 * `docker stop <name>` — stops the container but preserves its filesystem,
 * volume mounts, and config. Used for scale-to-zero so that a subsequent
 * `docker start` can bring it back up in ~1s without re-running `docker run`.
 * Returns true if the container was stopped (or already stopped), false if it
 * didn't exist.
 */
export async function stopContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker stop ${containerName} 2>&1"`,
    hostKey
  );
  if (result.exitCode === 0) return true;
  // `docker stop` on a nonexistent container prints "No such container"
  if (/No such container/i.test(result.stdout + result.stderr)) return false;
  throw new Error(`Failed to stop container ${containerName}: ${result.stderr || result.stdout}`);
}

/**
 * `docker start <name>` — starts a previously stopped container. Returns true
 * if started, false if the container doesn't exist (caller should fall back
 * to the full `docker run` path).
 */
export async function startContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker start ${containerName} 2>&1"`,
    hostKey
  );
  if (result.exitCode === 0) return true;
  if (/No such container/i.test(result.stdout + result.stderr)) return false;
  throw new Error(`Failed to start container ${containerName}: ${result.stderr || result.stdout}`);
}

/** Returns true iff a container with this name exists on the host (running or stopped). */
export async function containerExists(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker inspect ${containerName} >/dev/null 2>&1 && echo yes || echo no"`,
    hostKey
  );
  return result.stdout.trim() === "yes";
}

/**
 * `docker compose stop` — stops all containers in the compose project without
 * removing them. Counterpart to `startCompose`. Unlike `pauseCompose` (SIGSTOP)
 * this actually releases CPU/memory, making it the correct choice for
 * scale-to-zero.
 */
export async function stopCompose(ip: string, projectName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} stop"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to stop compose project");
  }
}

/** `docker compose start` — restarts a previously-stopped compose project. */
export async function startCompose(ip: string, projectName: string, hostKey?: string) {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} start"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error("Failed to start compose project");
  }
}

/** Returns true iff the compose project directory exists on the host. */
export async function composeProjectExists(ip: string, projectName: string, hostKey?: string): Promise<boolean> {
  const appDir = `/home/deploy/apps/${projectName}`;
  const result = await sshExec(
    ip,
    `[ -d "${appDir}" ] && echo yes || echo no`,
    hostKey
  );
  return result.stdout.trim() === "yes";
}

// --- Docker Network for Services ---

export async function ensureOcdNetwork(ip: string, hostKey?: string): Promise<void> {
  await sshExec(
    ip,
    `su - deploy -c "docker network inspect ocd-net >/dev/null 2>&1 || docker network create ocd-net"`,
    hostKey
  );
}

// --- Infrastructure Service Containers ---

export async function pullAndRunService(
  ip: string,
  opts: {
    name: string;
    image: string;           // e.g. "postgres:17-alpine"
    port: number;            // container port
    hostPort: number;        // host-side port
    envVars: Record<string, string>;
    volumeMount?: string;    // e.g. "/mnt/ocd-my-postgres-data:/var/lib/postgresql/data"
    cmd?: string[];          // custom entrypoint/cmd args
    bindAddress?: string;    // "127.0.0.1" (default) or "0.0.0.0"
    extraVolumes?: string[]; // additional -v mounts (e.g. config files)
    gitToken?: string;       // GitHub token for ghcr.io private images
  },
  hostKey?: string
): Promise<{ containerId: string }> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const bindAddr = opts.bindAddress || "127.0.0.1";

  // Authenticate with ghcr.io for private GitHub Container Registry images
  if (opts.gitToken && opts.image.startsWith("ghcr.io/")) {
    await dockerLoginGhcr(ip, opts.gitToken, hostKey);
  }

  log("service", `Pulling image ${opts.image}...`);
  const pullResult = await sshExec(ip, asUser(`docker pull ${opts.image}`), hostKey);
  if (pullResult.exitCode !== 0) {
    throw new Error(`Failed to pull image ${opts.image}: ${pullResult.stderr}`);
  }

  // Ensure ocd-net exists
  await ensureOcdNetwork(ip, hostKey);

  // Write env file
  const envEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envEntries.length > 0) {
    const svcDir = `/home/deploy/services/${opts.name}`;
    await sshExec(ip, `mkdir -p ${svcDir} && chown deploy:deploy ${svcDir}`, hostKey);
    const envFilePath = `${svcDir}/.env.deploy`;
    const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
      hostKey
    );
    envFileFlag = `--env-file ${envFilePath}`;
  }

  // Remove existing container if any
  await sshExec(ip, asUser(`docker rm -f ${opts.name} 2>/dev/null || true`), hostKey);

  // Build run command
  const volumeFlag = opts.volumeMount ? `-v ${opts.volumeMount}` : "";
  const extraVolFlags = (opts.extraVolumes || []).map((v) => `-v ${v}`).join(" ");
  const cmdStr = opts.cmd ? opts.cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(" ") : "";

  const runCmd = [
    `docker run -d`,
    `--name ${opts.name}`,
    `--restart unless-stopped`,
    `--network ocd-net`,
    `-p ${bindAddr}:${opts.hostPort}:${opts.port}`,
    envFileFlag,
    volumeFlag,
    extraVolFlags,
    opts.image,
    cmdStr,
  ].filter(Boolean).join(" ");

  log("service", `Docker run: ${runCmd}`);
  const result = await sshExec(ip, asUser(runCmd), hostKey);
  if (result.exitCode !== 0) {
    log("service", `Docker run stderr: ${result.stderr}`);
    throw new Error(`Failed to start service container ${opts.name}: ${result.stderr}`);
  }

  const containerId = result.stdout.trim().slice(0, 12);
  log("service", `Service container started: ${containerId}`);
  return { containerId };
}

export async function serviceHealthCheck(
  ip: string,
  containerName: string,
  healthCmd: string,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; error?: string }> {
  log("health", `Service health check for ${containerName}: ${healthCmd}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Check container is running
    const inspect = await sshExec(
      ip,
      `su - deploy -c "docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null"`,
      hostKey
    );
    if (inspect.stdout.trim() !== "true") {
      if (i < maxAttempts - 1) {
        log("health", `Service container not running yet (attempt ${i + 1}/${maxAttempts})`);
        await Bun.sleep(3000);
        continue;
      }
      return { healthy: false, error: "Container is not running" };
    }

    // Run health check command inside container
    const result = await sshExec(
      ip,
      `su - deploy -c "docker exec ${containerName} sh -c '${healthCmd.replace(/'/g, "'\\''")}'  2>&1"`,
      hostKey
    );

    if (result.exitCode === 0) {
      log("health", `Service health check passed for ${containerName}`);
      return { healthy: true };
    }

    if (i < maxAttempts - 1) {
      log("health", `Service health check failed (attempt ${i + 1}/${maxAttempts}): ${result.stdout.trim()}`);
      await Bun.sleep(3000);
    } else {
      return { healthy: false, error: `Health check failed: ${result.stdout.trim() || result.stderr.trim()}` };
    }
  }

  return { healthy: false, error: "Health check timed out" };
}

export async function deployConfigFile(
  ip: string,
  remotePath: string,
  content: string,
  hostKey?: string
): Promise<void> {
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  await sshExec(ip, `mkdir -p ${dir}`, hostKey);
  const escaped = content.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${escaped}' > ${remotePath} && chmod 644 ${remotePath}`, hostKey);
}
