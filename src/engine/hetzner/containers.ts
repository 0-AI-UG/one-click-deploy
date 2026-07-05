import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { sshExec, getSshKeyPath, describeFailure } from "./ssh.ts";
import { assertSafeHostPath } from "../../shared/validate.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

// Label applied to every image built or managed by OCD. Used by `pruneServer`
// to scope aggressive image cleanup so we never touch images that belong to
// other applications on the same host.
export const OCD_IMAGE_LABEL_KEY = "ocd.managed";
export const OCD_IMAGE_LABEL = `${OCD_IMAGE_LABEL_KEY}=true`;

// Default per-container resource ceilings. Applied to every app/replica unless
// the caller overrides. Sized for small web apps; infra services pass their
// own higher ceilings via opts.
export const DEFAULT_MEM_MB = 512;
export const DEFAULT_CPUS = 1;
export const DEFAULT_PIDS = 512;

export type DockerRunVolume = { host: string; container: string };

export type DockerRunOpts = {
  /** Container name (--name). */
  name: string;
  /** Image reference (e.g. "myapp:latest" or "postgres:17-alpine"). */
  image: string;
  /** App name used to scope the volume host-path allowlist. */
  appName: string;
  /** Override the docker network. Default "ocd-net". Pass null to skip --network. */
  network?: string | null;
  /** Port publish spec. Omit for containers that don't expose ports. */
  publish?: { bindAddr: string; hostPort: number; containerPort: number };
  /** Absolute path to env-file on the host (--env-file). */
  envFilePath?: string;
  /** Primary "host:container" volume mount string (validated). */
  volumeMount?: string;
  /** Additional "host:container" volume mount strings (validated). */
  extraVolumes?: string[];
  /** Per-container memory ceiling in MB. Default DEFAULT_MEM_MB. */
  memoryMb?: number;
  /** Per-container CPU ceiling. Default DEFAULT_CPUS. */
  cpus?: number;
  /** Per-container pids cap. Default DEFAULT_PIDS. */
  pidsLimit?: number;
  /** Extra Linux capabilities to add back after --cap-drop=ALL. */
  extraCaps?: string[];
  /** --restart policy. Default "unless-stopped". */
  restart?: string;
  /** Optional trailing command/args (already shell-escaped by caller). */
  cmd?: string;
};

function parseVolumeSpec(spec: string): { host: string; container: string } | null {
  // Volume strings are "host:container" or "host:container:ro" etc.
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) return null;
  const host = spec.slice(0, idx);
  const rest = spec.slice(idx + 1);
  // Container path may itself contain ":ro" suffix; strip after the next colon.
  const containerEnd = rest.indexOf(":");
  const container = containerEnd === -1 ? rest : rest.slice(0, containerEnd);
  return { host, container };
}

/**
 * Build a hardened `docker run` shell command. Centralizes capability drops,
 * no-new-privileges, pid limits, and default mem/cpu ceilings so no callsite
 * can forget them. Validates every host-path volume against the allowlist.
 */
export function buildDockerRunArgs(opts: DockerRunOpts): string {
  const mem = opts.memoryMb ?? DEFAULT_MEM_MB;
  const cpus = opts.cpus ?? DEFAULT_CPUS;
  const pids = opts.pidsLimit ?? DEFAULT_PIDS;
  const restart = opts.restart ?? "unless-stopped";
  const network = opts.network === null ? null : (opts.network ?? "ocd-net");

  const parts: string[] = [
    "docker run -d",
    `--name ${opts.name}`,
    `--restart ${restart}`,
  ];
  if (network) parts.push(`--network ${network}`);
  parts.push(
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory ${mem}m`,
    `--memory-swap ${mem}m`,
    `--cpus ${cpus}`,
    `--pids-limit ${pids}`,
  );
  for (const cap of opts.extraCaps ?? []) {
    parts.push(`--cap-add=${cap}`);
  }

  if (opts.publish) {
    const { bindAddr, hostPort, containerPort } = opts.publish;
    parts.push(`-p ${bindAddr}:${hostPort}:${containerPort}`);
  }
  if (opts.envFilePath) parts.push(`--env-file ${opts.envFilePath}`);

  const allVolumes: string[] = [];
  if (opts.volumeMount) allVolumes.push(opts.volumeMount);
  if (opts.extraVolumes) allVolumes.push(...opts.extraVolumes);
  for (const spec of allVolumes) {
    const parsed = parseVolumeSpec(spec);
    if (!parsed) throw new Error(`Invalid volume spec: ${spec}`);
    assertSafeHostPath(parsed.host, opts.appName);
    parts.push(`-v ${spec}`);
  }

  parts.push(opts.image);
  if (opts.cmd) parts.push(opts.cmd);
  return parts.join(" ");
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
    build?: { labels?: string[] };
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
    // Remove all tags for this app except :latest and :rollback — old commit
    // tags are no longer needed since rollback rebuilds from git. The
    // `:rollback` tag pins the previous image so a failed redeploy can restore
    // it (redeploy op drops the tag on success/compensation).
    `docker images ${appName} --format '{{.Repository}}:{{.Tag}}' | grep -vE ':(latest|rollback)$' | xargs -r docker rmi 2>/dev/null || true`,
    // Prune dangling images (untagged layers from previous builds). Scoped to
    // OCD-labeled layers so we never drop intermediate layers that belong to
    // other applications on this host.
    `docker image prune -f --filter label=${OCD_IMAGE_LABEL}`,
    // Compact the git repo
    `cd ${appDir} && git gc --auto 2>/dev/null || true`,
  ].join(" && ");

  sshExec(ip, asUser(cmd), hostKey).catch((err) => {
    log("prune", `Post-build cleanup on ${ip} failed (non-fatal): ${err}`);
  });
}

/**
 * Periodic disk cleanup. Two tiers based on disk pressure:
 *
 *   - Normal (root fs < 75% used): scoped prune. Removes unused OCD-labeled
 *     images, dangling images, foreign stopped containers, and ALL build
 *     cache (build cache is fully reproducible from sources).
 *
 *   - Pressure (root fs >= 75%): escalates to a full system prune. On an
 *     OCD-managed server there are essentially no non-OCD images worth
 *     preserving, and a crash from a full disk is far worse than a cold
 *     rebuild. Volumes are still preserved.
 *
 * NOTE: the container prune always excludes OCD-managed containers
 * (label!=ocd.managed=true). A sleeping app keeps its last container as a
 * *stopped* anchor so it can wake with a fast `docker start`; an unfiltered
 * `docker container prune` would delete that anchor, and once the container
 * is gone its image becomes unreferenced and gets swept by the image prune —
 * leaving the app unable to wake. OCD removes its own containers explicitly
 * (see scaleDown), so the blanket prune only needs to clear foreign junk.
 */
export async function pruneServer(ip: string, hostKey?: string) {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Probe disk usage on the root fs (where /var/lib/docker lives).
  const usage = await sshExec(ip, `df -P / | awk 'NR==2 {gsub("%",""); print $5}'`, hostKey);
  const usedPct = parseInt(usage.stdout.trim(), 10) || 0;
  const underPressure = usedPct >= 75;

  // Build the prune pipeline. Each step's output is trimmed to its summary
  // line so the log entry stays one line per server.
  const steps = underPressure
    ? [
        // Aggressive: anything not currently in use, plus all build cache.
        // Still preserve OCD-managed containers (sleeping anchors) so wake
        // stays fast and their images survive the image prune below.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -af 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ]
    : [
        // Scoped: OCD-labeled images, dangling layers, foreign stopped
        // containers, and all build cache (always reproducible from sources).
        // Excludes OCD-managed containers so sleeping anchors are never swept.
        `docker container prune -f --filter "label!=${OCD_IMAGE_LABEL}" 2>&1 | tail -1`,
        `docker image prune -a -f --filter label=${OCD_IMAGE_LABEL} 2>&1 | tail -1`,
        `docker image prune -f 2>&1 | tail -1`,
        `docker builder prune -af 2>&1 | tail -1`,
      ];
  const result = await sshExec(ip, asUser(steps.join("; ")), hostKey);
  const tag = underPressure ? "prune(pressure)" : "prune";
  log(tag, `Server ${ip} (disk ${usedPct}%): ${result.stdout.trim().replace(/\n/g, " | ")}`);
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
    // Save and compress on source (as deploy user who owns docker).
    // `set -o pipefail` is critical: without it, a failed `docker save` (e.g.
    // image missing on source) returns 0 because gzip happily emits an empty
    // archive, which then fails on the target with a cryptic "repositories:
    // no such file or directory" during `docker load`.
    const saveResult = await sshExec(
      sourceIp,
      `su - deploy -c "set -o pipefail; docker save ${imageName} | gzip" > ${tmpFile}`,
      sourceHostKey
    );
    if (saveResult.exitCode !== 0) {
      throw new Error(describeFailure("Failed to export Docker image from source server", saveResult));
    }
    // Defense in depth: if pipefail somehow didn't trip (e.g. non-bash login
    // shell), refuse to ship an obviously-empty archive.
    const sizeResult = await sshExec(sourceIp, `stat -c %s ${tmpFile} 2>/dev/null || echo 0`, sourceHostKey);
    const archiveBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
    if (archiveBytes < 1024) {
      throw new Error(`Exported image archive is suspiciously small (${archiveBytes} bytes) — image ${imageName} may not exist on the source server`);
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
      const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) || `exit ${downExit}`;
      throw new Error(`Failed to download image from source server: ${detail}`);
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
      const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) || `exit ${upExit}`;
      throw new Error(`Failed to upload image to target server: ${detail}`);
    }

    // Load on target — run docker load as deploy, but file is owned by root
    // So: gunzip as root, pipe to deploy's docker load
    const loadResult = await sshExec(
      targetIp,
      `gunzip -c ${tmpFile} | su - deploy -c "docker load"`,
      targetHostKey
    );
    if (loadResult.exitCode !== 0) {
      throw new Error(describeFailure("Failed to import Docker image on target server", loadResult));
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

  const routeJson = JSON.stringify(route);
  const escaped = routeJson.replace(/'/g, "'\\''");

  // Add the route via the admin API, waiting for Caddy to be ready. Right after
  // boot/restart the admin API can be briefly unavailable or reject the config,
  // so poll with a bounded backoff instead of trying once. `curl -f` swallows
  // the HTTP error body, so capture the status code + body explicitly here —
  // otherwise a failure surfaces only as a useless "exit 22" with no cause.
  const postCmd =
    `curl -s -o /tmp/ocd-caddy-resp -w '%{http_code}' -X POST ` +
    `-H 'Content-Type: application/json' -d '${escaped}' ` +
    `http://localhost:2019/config/apps/http/servers/srv0/routes; ` +
    `echo; cat /tmp/ocd-caddy-resp 2>/dev/null`;
  const ADMIN_WAIT_MS = 30_000;
  const deadline = Date.now() + ADMIN_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    // Delete any existing route with this id first (ignore errors if absent).
    await sshExec(ip, `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`, hostKey);
    const res = await sshExec(ip, postCmd, hostKey);
    const [codeLine, ...bodyLines] = res.stdout.split("\n");
    const httpCode = parseInt(codeLine.trim(), 10);
    const body = bodyLines.join("\n").trim();
    if (res.exitCode === 0 && httpCode >= 200 && httpCode < 300) break;
    const desc = `HTTP ${Number.isNaN(httpCode) ? "?" : httpCode}${body ? ` ${body}` : ` (curl exit ${res.exitCode})`}`;
    if (Date.now() >= deadline) {
      throw new Error(`Failed to configure Caddy reverse proxy for ${domain}: ${desc}`);
    }
    log("caddy", `Route add attempt ${attempt} failed (${desc}); restarting Caddy and retrying...`);
    await sshExec(ip, "systemctl restart caddy", hostKey);
    await Bun.sleep(2000);
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
      throw new Error(describeFailure(`Failed to configure Caddy wake page for ${domain}`, retry));
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

/**
 * Remove the Caddy wake-page route for a domain. Called when the app wakes
 * so the (terminal) wake-page route stops shadowing the real app route in
 * srv0/routes. Best-effort — a missing route is treated as success.
 */
export async function removeCaddyWakePage(
  ip: string,
  domain: string,
  hostKey?: string,
) {
  if (!domain) return;
  const routeId = `ocd-${domain.replace(/\./g, "-")}`;
  await sshExec(ip, `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`, hostKey);
  await persistCaddyConfig(ip, hostKey);
  log("caddy", `Wake page removed: domain=${domain}`);
}

// --- Registry Auth ---

export type GhcrAuth = {
  /** Absolute path on the remote host to a DOCKER_CONFIG dir holding the ephemeral creds. */
  dockerConfig: string;
  /** Shell prefix to prepend to docker invocations so they pick up the ephemeral creds. */
  envPrefix: string;
  /** Best-effort cleanup of the credential dir. Always call in a `finally`. */
  cleanup: () => Promise<void>;
};

/**
 * Authenticate against ghcr.io into a *per-deploy* DOCKER_CONFIG dir instead
 * of the user's persistent `~/.docker/config.json`. The returned `envPrefix`
 * must be prepended to subsequent `docker pull` / `docker build` / `docker
 * compose` invocations that need the credentials; `cleanup()` removes the
 * config dir so the token never outlives the deploy.
 */
async function dockerLoginGhcr(
  ip: string,
  token: string,
  hostKey?: string,
): Promise<GhcrAuth> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  // Random per-deploy dir, owned by `deploy` user (the uid that runs docker).
  const rand = Math.random().toString(36).slice(2, 12);
  const dockerConfig = `/home/deploy/.docker-ocd-${rand}`;
  const escaped = token.replace(/'/g, "'\\''");
  const result = await sshExec(
    ip,
    asUser(
      `mkdir -p ${dockerConfig} && chmod 700 ${dockerConfig} && ` +
      `DOCKER_CONFIG=${dockerConfig} sh -c "echo '${escaped}' | docker login ghcr.io -u x-access-token --password-stdin"`,
    ),
    hostKey,
  );
  if (result.exitCode !== 0) {
    log("registry", `ghcr.io login failed: ${result.stderr}`);
    // Best-effort: nuke the dir even on failure so a half-written config
    // doesn't linger.
    await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch(() => {});
    throw new Error(
      "Failed to authenticate with GitHub Container Registry (ghcr.io). Check your GitHub token has the read:packages scope.",
    );
  }
  log("registry", "ghcr.io login succeeded (ephemeral DOCKER_CONFIG)");
  return {
    dockerConfig,
    envPrefix: `DOCKER_CONFIG=${dockerConfig} `,
    cleanup: async () => {
      const r = await sshExec(ip, asUser(`rm -rf ${dockerConfig}`), hostKey).catch((err) => {
        log("registry", `ghcr cleanup failed (non-fatal): ${err}`);
        return null;
      });
      if (r && r.exitCode !== 0) {
        log("registry", `ghcr cleanup non-zero exit: ${r.stderr}`);
      }
    },
  };
}

// --- Clone & Build ---

// Shared git clone/pull logic used by cloneAndBuild.
export async function cloneRepo(
  ip: string,
  appName: string,
  gitRepo: string,
  gitToken?: string,
  emit?: (msg: string) => void,
  gitBranch?: string,
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

  const branchFlag = gitBranch ? ` -b ${gitBranch}` : "";
  emit?.("Cloning repository...");
  log("build", `Cloning ${gitRepo} into ${appDir} (token: ${gitToken ? "yes" : "no"}, branch: ${gitBranch || "default"})`);
  // Ensure the app dir (if it exists) is owned by deploy so the subsequent
  // rm -rf/git clone/pull works even if a prior root-run step (e.g. scaleUp
  // writing .env.deploy) left root-owned files behind.
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps && mkdir -p ${appDir} && chown -R deploy:deploy ${appDir}`);
  const gitEnv = gitToken ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
  const cloneResult = await sshExec(
    ip,
    asUser(`${gitEnv}if [ -d "${appDir}/.git" ]; then cd ${appDir} && git remote set-url origin ${cloneUrl} && git fetch origin && git checkout ${gitBranch || "HEAD"} && git pull; else rm -rf ${appDir} && git clone${branchFlag} ${cloneUrl} ${appDir}; fi`)
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
    throw new Error(describeFailure("Git clone failed", cloneResult));
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
    gitBranch?: string; // Branch to clone, defaults to repo default
    /** Host-side bind address for the published port. Defaults to 127.0.0.1
     *  so containers aren't exposed on the public interface. Pass the
     *  server's `private_ipv4` when the app is reached by the panel Caddy
     *  over the shared private network. */
    bindAddr?: string;
    /** Override for the docker container name. Defaults to `opts.name`.
     *  Needed when redeploying a replica whose container is named
     *  `${app}-r${n}` (from scaleUp/migrate) rather than bare `${app}`. */
    containerName?: string;
    /** When true, assume the repo is already cloned (the engine `clone_repo`
     *  step ran first). Skips the in-helper clone. */
    skipClone?: boolean;
    /** Per-container memory ceiling in MB. Omit / 0 → platform default. */
    memoryMb?: number;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  if (!opts.skipClone) {
    await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit, opts.gitBranch);
  }

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
  // private base images in FROM directives). Credentials live in a per-deploy
  // DOCKER_CONFIG dir and are wiped immediately after the build.
  let ghcrAuth: GhcrAuth | null = null;
  if (opts.gitToken) {
    ghcrAuth = await dockerLoginGhcr(ip, opts.gitToken);
  }

  // Build image first (before stopping old container — build-before-destroy)
  emit("Building Docker image...");
  const dockerContext = opts.dockerContext || ".";
  const ghcrPrefix = ghcrAuth?.envPrefix ?? "";
  const buildCmd = `cd ${appDir} && ${ghcrPrefix}docker build --label ${OCD_IMAGE_LABEL} -t ${opts.name}:latest -f ${dockerfilePath} ${dockerContext}`;
  log("build", `Docker build command: ${buildCmd}`);
  const dockerBuildStart = Date.now();
  const buildResult = await sshExec(ip, asUser(buildCmd));
  if (ghcrAuth) await ghcrAuth.cleanup();
  if (buildResult.exitCode !== 0) {
    log("build", `Docker build stderr: ${buildResult.stderr.slice(0, 500)}`);
    throw new Error(describeFailure("Docker build failed", buildResult));
  }
  log("build", `Docker build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully");

  // Build succeeded — now safe to stop old container and swap
  const containerName = opts.containerName || opts.name;
  log("build", `Removing existing container ${containerName} (if any)`);
  await sshExec(ip, asUser(`docker rm -f ${containerName} 2>/dev/null || true`));

  // Write env file to server (avoids shell injection via env var values)
  const envFileEntries = Object.entries(opts.envVars);
  let envFilePath: string | undefined;
  if (envFileEntries.length > 0) {
    envFilePath = `/home/deploy/apps/${opts.name}/.env.deploy`;
    const envFileContent = envFileEntries
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`);
  }

  // Run container
  emit("Starting container...");
  // Ensure ocd-net exists so apps can reach infrastructure services by container name
  await ensureOcdNetwork(ip);
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const cmd = buildDockerRunArgs({
    name: containerName,
    image: `${opts.name}:latest`,
    appName: opts.name,
    publish: { bindAddr, hostPort: opts.hostPort, containerPort: opts.port },
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb || undefined,
  });
  log("build", `Docker run: ${cmd}`);
  const result = await sshExec(ip, asUser(cmd));
  if (result.exitCode !== 0) {
    log("build", `Docker run stderr: ${result.stderr}`);
    throw new Error(describeFailure("Failed to start container", result));
  }
  log("build", `Container started: ${result.stdout.trim().slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name);

  return { containerId: result.stdout.trim(), dockerfilePath, imageTag: `${opts.name}:latest` };
}

export async function removeContainer(ip: string, name: string, hostKey?: string) {
  await sshExec(ip, `su - deploy -c "docker rm -f ${name} 2>/dev/null || true"`, hostKey);
}

// --- Docker Compose Support (catalog services only) ---

/**
 * Deploy a multi-container *catalog service* from a bundled compose template.
 * There is no git repo — the template ships with OCD and is written straight to
 * the host. Persistent data and the public port are supplied via the generated
 * `docker-compose.ocd.yml` override (the base template declares neither).
 *
 * Services live under `/home/deploy/services/<name>` (NOT the apps dir); pass
 * `baseDir: "/home/deploy/services"` to the compose lifecycle/health helpers
 * for these projects.
 */
export async function pullAndRunComposeService(
  ip: string,
  opts: {
    name: string; // compose project name (== service name)
    composeTemplate: string; // bundled docker-compose.yml text
    webService: string; // service Caddy proxies (gets the published port)
    webPort: number; // that service's internal port
    hostPort: number; // host-side published port
    bindAddr: string; // host bind address (server private IPv4)
    envVars: Record<string, string>;
    /** Per-service bind mounts ("host:container") injected into the override. */
    overrideVolumes: Record<string, string[]>;
    /** Host directories to pre-create (the volume subpaths) before `up`. */
    hostDirs: string[];
  },
  hostKey?: string,
): Promise<void> {
  const svcDir = `/home/deploy/services/${opts.name}`;
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const writeFile = async (path: string, content: string) => {
    const escaped = content.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escaped}' > ${path} && chown deploy:deploy ${path}`, hostKey);
  };

  await sshExec(ip, `mkdir -p ${svcDir} && chown deploy:deploy ${svcDir}`, hostKey);

  // Pre-create the volume subpath directories so the bind mounts resolve.
  if (opts.hostDirs.length > 0) {
    const mk = opts.hostDirs.map((d) => `mkdir -p ${d}`).join(" && ");
    await sshExec(ip, `${mk} && chown -R deploy:deploy ${opts.hostDirs.map((d) => d).join(" ")}`, hostKey);
  }

  // Base template (data paths + public port deliberately omitted).
  await writeFile(`${svcDir}/docker-compose.yml`, opts.composeTemplate);

  // Override: publish the web service + inject per-component bind mounts.
  const overrideServices: ComposeOverrideServices = {
    [opts.webService]: {
      ports: [`${opts.bindAddr}:${opts.hostPort}:${opts.webPort}`],
    },
  };
  for (const [svc, vols] of Object.entries(opts.overrideVolumes)) {
    if (vols.length === 0) continue;
    overrideServices[svc] = overrideServices[svc] || {};
    overrideServices[svc].volumes = vols;
  }
  await writeFile(`${svcDir}/docker-compose.ocd.yml`, JSON.stringify({ services: overrideServices }));

  // Env file (secrets, passwords, image tag).
  const envEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envEntries.length > 0) {
    const envFilePath = `${svcDir}/.env.deploy`;
    const envContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
    const escaped = envContent.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `echo '${escaped}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
      hostKey,
    );
    envFileFlag = `--env-file ${envFilePath}`;
  }

  const composeCmd = `cd ${svcDir} && docker compose -f docker-compose.yml -f docker-compose.ocd.yml -p ${opts.name} ${envFileFlag} up -d`;
  log("service", `Compose service command: ${composeCmd}`);
  const result = await sshExec(ip, asUser(composeCmd), hostKey);
  if (result.exitCode !== 0) {
    log("service", `Compose service up stderr: ${result.stderr.slice(0, 500)}`);
    throw new Error(describeFailure("Docker Compose service start failed", result));
  }
  log("service", `Compose service ${opts.name} started`);
}

// --- Compose Lifecycle Operations ---

export async function restartCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} restart"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(describeFailure("Failed to restart compose project", result));
  }
}

export async function pauseCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} pause"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(describeFailure("Failed to pause compose project", result));
  }
}

export async function unpauseCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} unpause"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(describeFailure("Failed to unpause compose project", result));
  }
}

export async function removeCompose(ip: string, projectName: string, removeVolumes = false, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
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
  hostKey?: string,
  baseDir = "/home/deploy/apps"
): Promise<string> {
  const appDir = `${baseDir}/${projectName}`;
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
  hostKey?: string,
  baseDir = "/home/deploy/apps"
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  log("health", `Checking compose health of ${projectName} on ${ip} via ${bindHost}:${port}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Check all services are running
    const appDir = `${baseDir}/${projectName}`;
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
    throw new Error(describeFailure("Failed to restart container", result));
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
    throw new Error(describeFailure("Failed to pause container", result));
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
    throw new Error(describeFailure("Failed to unpause container", result));
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
    /** Override memory ceiling (MB). Infra services may need more than the app default. */
    memoryMb?: number;
    /** Override CPU ceiling. */
    cpus?: number;
    /** Capabilities to add back after --cap-drop=ALL (e.g. ["CHOWN","SETUID","SETGID"] for postgres). */
    extraCaps?: string[];
  },
  hostKey?: string
): Promise<{ containerId: string }> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const bindAddr = opts.bindAddress || "127.0.0.1";

  // Authenticate with ghcr.io for private GitHub Container Registry images.
  // Credentials live in a per-pull DOCKER_CONFIG dir and are wiped after.
  let ghcrAuth: GhcrAuth | null = null;
  if (opts.gitToken && opts.image.startsWith("ghcr.io/")) {
    ghcrAuth = await dockerLoginGhcr(ip, opts.gitToken, hostKey);
  }

  log("service", `Pulling image ${opts.image}...`);
  const ghcrPrefix = ghcrAuth?.envPrefix ?? "";
  const pullResult = await sshExec(ip, asUser(`${ghcrPrefix}docker pull ${opts.image}`), hostKey);
  if (ghcrAuth) await ghcrAuth.cleanup();
  if (pullResult.exitCode !== 0) {
    throw new Error(`Failed to pull image ${opts.image}: ${pullResult.stderr}`);
  }

  // Ensure ocd-net exists
  await ensureOcdNetwork(ip, hostKey);

  // Write env file
  const envEntries = Object.entries(opts.envVars);
  let envFilePath: string | undefined;
  if (envEntries.length > 0) {
    const svcDir = `/home/deploy/services/${opts.name}`;
    await sshExec(ip, `mkdir -p ${svcDir} && chown deploy:deploy ${svcDir}`, hostKey);
    envFilePath = `${svcDir}/.env.deploy`;
    const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
      hostKey
    );
  }

  // Remove existing container if any
  await sshExec(ip, asUser(`docker rm -f ${opts.name} 2>/dev/null || true`), hostKey);

  // Build run command
  const cmdStr = opts.cmd ? opts.cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(" ") : undefined;

  const runCmd = buildDockerRunArgs({
    name: opts.name,
    image: opts.image,
    appName: opts.name,
    publish: { bindAddr, hostPort: opts.hostPort, containerPort: opts.port },
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
    extraCaps: opts.extraCaps,
    cmd: cmdStr,
  });

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
