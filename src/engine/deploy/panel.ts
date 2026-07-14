// Panel lifecycle — bootstrap + self-redeploy for the hosted panel.
//
// The panel is deliberately NOT an apps-table row. It lives in its own
// `panel` singleton table so the regular app deploy/redeploy/scale/lifecycle
// code paths never see it.
//
// Two entry points:
//   - bootstrapPanel(): run once from auto-deploy (headless bootstrap in a
//     local Docker container). Provisions a Hetzner server, volume, DNS,
//     builds the panel image, hands off a snapshot of the bootstrap DB to
//     the server's volume, then starts the hosted container.
//   - redeployPanel(): run from inside the hosted panel when the operator
//     clicks "Redeploy" in Settings. Dispatches a detached rebuild on the
//     host via systemd-run so the panel can kill and replace itself without
//     SSH blocking. All DB writes happen BEFORE dispatch so they land even
//     if the panel container is destroyed seconds later.
import { resolve4 } from "node:dns/promises";
import * as db from "../../shared/db.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import {
  sshExec, waitForServer, captureHostKey, getOrCreateLocalKeyPair,
  cloneAndBuild, healthCheck, getContainerLogs,
} from "../../shared/remote/index.ts";
import { deployTraefikPanelSite } from "../scale/traefik-manager.ts";
import { getOrResolveZoneName } from "../../shared/dns-zone.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { handoffDbToVolume } from "./self-deploy.ts";
import { dockerLoginGhcr } from "../hetzner/registry.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [panel:${context}]`, ...args);
}

/** Best-effort check that `domain` has an A record pointing at `ip`. */
async function checkDnsResolves(domain: string, ip: string): Promise<boolean> {
  try {
    const addrs = await resolve4(domain);
    return addrs.includes(ip);
  } catch {
    return false;
  }
}

/**
 * Poll https://domain until it responds (any non-5xx status counts as "up").
 * Best-effort: returns false after `attempts` failures rather than throwing,
 * since a not-yet-issued cert or unpropagated DNS is expected, not fatal.
 */
async function waitForHttps(domain: string, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`https://${domain}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      if (res.status < 500) return true;
    } catch {
      // DNS/cert not ready yet — retry.
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

export type BootstrapPanelOpts = {
  appName: string;
  /** Public domain. When omitted, a `<server-ip>.nip.io` domain is derived
   *  after the server is created and served with a self-signed cert. */
  domain?: string;
  gitRepo: string;
  containerPort: number;
  envVars: Record<string, string>;
  serverType: string;
  serverLocation: string;
  volumeSize: number;
  volumePath: string;
  dnsZoneId?: string;
  webhookBranch?: string;
  enableWebhook?: boolean;
};

/**
 * Provision infrastructure for the hosted panel and hand off the bootstrap
 * DB to it. Must be called from the local bootstrap panel (the Docker
 * container started by the one-liner install). On success, the Hetzner
 * server is running the panel image with the bootstrap DB loaded; the
 * bootstrap can exit.
 */
export async function bootstrapPanel(
  opts: BootstrapPanelOpts,
  onProgress: ProgressFn,
): Promise<{
  ok: boolean;
  error?: string;
  domain?: string;
  serverIp?: string;
  dnsAutoCreated?: boolean;
  dnsResolved?: boolean;
  internalTls?: boolean;
}> {
  const t0 = Date.now();
  // Resolved below: either the caller-supplied domain, or a `<ip>.nip.io`
  // derived once the server (and its IP) exists.
  let domain = opts.domain;
  log("start", `Bootstrapping panel ${opts.appName} → ${domain ?? "<ip>.nip.io (auto)"}`);

  if (!opts.envVars.JWT_SECRET) {
    return { ok: false, error: "bootstrapPanel requires env_vars.JWT_SECRET" };
  }
  if (!opts.volumeSize || opts.volumeSize <= 0) {
    return { ok: false, error: "bootstrapPanel requires a persistent volume" };
  }
  if (db.getPanel()) {
    return { ok: false, error: "Panel already bootstrapped in this DB" };
  }

  // Rollback state
  let providerServerId: string | undefined;
  let dbServerId: number | undefined;
  let volumeId: string | undefined;
  let dnsRecordKey: { zoneId: string; name: string; type: string; value: string } | undefined;

  const compute = hetzner;
  const dns = hetznerDns;

  try {
    // 0. Guard against duplicate provisioning. The bootstrap DB is ephemeral
    //    (the container runs with --rm), so the db.getPanel() check above can't
    //    catch a panel that a previous run already created. Ask the provider
    //    directly: if a server for this app already exists, refuse rather than
    //    silently spinning up a second paid server.
    onProgress("server", "Checking for an existing panel server...");
    const existing = (await compute.listServers()).find((s) =>
      s.name.startsWith(`ocd-${opts.appName}-`),
    );
    if (existing) {
      return {
        ok: false,
        error:
          `A panel server already exists (${existing.name} @ ${existing.ipv4}). ` +
          (domain ? `The panel may already be live at https://${domain}. ` : "") +
          `Destroy that server in the Hetzner console before re-running bootstrap.`,
      };
    }

    // 0.5. Resolve the managed zone's name BEFORE the server is created:
    //    cloud-init renders the Traefik static config from this DB, and the
    //    cached `dns_zone_name` is what gates the wildcard (DNS-01) resolver
    //    and derives the ACME email. Best-effort — "" falls back to the
    //    per-domain HTTP-01 path exactly as before.
    const zoneName = opts.dnsZoneId ? await getOrResolveZoneName() : "";

    // 1. SSH key + firewall + private network
    onProgress("server", "Ensuring SSH key + firewall + network...");
    const { publicKey } = await getOrCreateLocalKeyPair();
    const [sshKey, firewallId, networkId] = await Promise.all([
      compute.ensureSshKey("one-click-deploy", publicKey),
      compute.ensureFirewall(),
      ensureSharedNetwork(),
    ]);

    // 2. Create server
    onProgress("server", "Creating server...");
    const serverName = `ocd-${opts.appName}-${Date.now()}`;
    const dbServer = db.insertServer({
      name: serverName,
      provider_id: "",
      ipv4: "",
      ipv6: "",
      type: opts.serverType,
      location: opts.serverLocation,
      status: "creating",
    });
    dbServerId = dbServer.id;

    const providerServer = await compute.createServer({
      name: serverName,
      serverType: opts.serverType,
      location: opts.serverLocation,
      sshKeyName: sshKey.name,
      firewallId,
      networkId: networkId || undefined,
      userData: "",
    });
    providerServerId = providerServer.providerId;
    const serverIp = providerServer.ipv4;
    db.updateServer(dbServer.id, {
      provider_id: providerServerId,
      ipv4: serverIp,
      ipv6: providerServer.ipv6 || "",
      private_ipv4: providerServer.privateIpv4 || "",
      status: "provisioning",
    });
    onProgress("server", `Server created: ${serverIp}`);

    // No domain supplied → derive a self-resolving <ip>.nip.io domain now that
    // we know the IP, and serve it with Traefik's default (self-signed) cert.
    // This is the "no domain, no DNS" path; the browser warns on first visit.
    if (!domain) {
      domain = `${serverIp.replace(/\./g, "-")}.nip.io`;
      onProgress("server", `No domain supplied — using ${domain} (self-signed TLS)`);
    }

    // 3. Wait for boot + cloud-init
    onProgress("provision", "Waiting for server to boot...");
    await compute.waitForRunning(providerServerId, (msg) => onProgress("provision", msg));
    onProgress("provision", "Waiting for cloud-init...");
    await waitForServer(serverIp, 30, (msg) => onProgress("provision", msg));

    const dockerCheck = await sshExec(serverIp, "docker --version");
    if (dockerCheck.exitCode !== 0) {
      throw new Error("Server provisioned but Docker is missing — cloud-init failed.");
    }

    // 4. Capture host key
    const hostKey = await captureHostKey(serverIp);
    if (hostKey) db.updateServerHostKey(dbServer.id, hostKey);
    db.updateServerStatus(dbServer.id, "ready");

    // 5. DNS (best-effort). Skipped for an auto-derived nip.io domain — it
    //    resolves via public wildcard DNS and isn't in the user's zone.
    if (opts.dnsZoneId && opts.domain) {
      try {
        const parts = domain.split(".");
        const sub = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
        await dns.createRecord({
          zoneId: opts.dnsZoneId,
          name: sub,
          type: "A",
          value: serverIp,
        });
        dnsRecordKey = { zoneId: opts.dnsZoneId, name: sub, type: "A", value: serverIp };
        onProgress("dns", `DNS A record created: ${domain} → ${serverIp}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress("dns", `DNS creation failed (continuing): ${msg}`);
      }
    }

    // 6. Create + mount volume
    onProgress("build", `Creating ${opts.volumeSize}GB persistent volume...`);
    if (!compute.volumes) throw new Error("Compute provider does not support volumes");
    const vol = await compute.volumes.create({
      name: `ocd-${opts.appName}-data`,
      sizeGb: opts.volumeSize,
      serverId: providerServerId,
      location: opts.serverLocation,
    });
    volumeId = vol.providerId;
    const hostMountPath = `/mnt/ocd-${opts.appName}-data`;
    {
      const { ensureVolumeBindMount } = await import("../hetzner/host-mounts.ts");
      // Wait briefly so automount settles before we bind on top.
      await new Promise((r) => setTimeout(r, 3000));
      await ensureVolumeBindMount({
        serverIp,
        hostKey: hostKey || undefined,
        hetznerVolumeId: volumeId,
        hostMountPath,
        blockName: `panel`,
      });
    }
    const volumeMount = `${hostMountPath}:${opts.volumePath}`;
    onProgress("build", `Volume ready (${volumeMount})`);

    // 7. Insert panel row in the BOOTSTRAP DB. Deliberately optimistic:
    //    status=running, an initial panel_deployment row. The snapshot we
    //    take in step 8 captures this, so the hosted instance boots already
    //    knowing who it is. If the subsequent build/health-check fails we
    //    roll back below and the volume (with snapshot) is destroyed.
    const hostPort = 3001;
    db.insertPanel({
      server_id: dbServer.id,
      name: opts.appName,
      domain: domain,
      git_repo: opts.gitRepo,
      git_branch: opts.webhookBranch || "main",
      container_port: opts.containerPort,
      host_port: hostPort,
      volume_id: volumeId,
      volume_mount: volumeMount,
      env_vars: JSON.stringify(opts.envVars),
      status: "running",
    });
    db.insertPanelDeployment({
      image_tag: `${opts.appName}:latest`,
      git_commit: "bootstrap",
      status: "deployed",
      source: "bootstrap",
    });
    db.appendPanelDeployLog(`[bootstrap] Panel deployed to ${domain}`);

    // Persist the DNS record on the panel row so destroyServer can clean it
    // up later (the panel lives outside the apps table, so dns_records keyed
    // by app_id wouldn't catch it).
    if (dnsRecordKey) {
      db.updatePanelDnsRecord({
        zone_id: dnsRecordKey.zoneId,
        name: dnsRecordKey.name,
        type: dnsRecordKey.type,
        value: dnsRecordKey.value,
      });
    }

    // 8. Handoff: snapshot bootstrap DB onto the mounted volume BEFORE the
    //    hosted container starts (so it opens the handed-off DB on first
    //    boot rather than a fresh one).
    onProgress("build", "Handing off DB to hosted volume...");
    await handoffDbToVolume({
      serverIp,
      hostKey: hostKey || undefined,
      hostMountPath,
    });

    // 9. Build image + run container
    onProgress("build", "Cloning repo and building image...");
    await cloneAndBuild(
      serverIp,
      {
        name: opts.appName,
        gitRepo: opts.gitRepo,
        port: opts.containerPort,
        hostPort,
        envVars: opts.envVars,
        volumeMount,
      },
      (line) => onProgress("build", line),
    );

    // 10. Ingress + TLS: write the panel's own Traefik vhost (panel.yml).
    // The file is owned by bootstrap and never rewritten by app syncs.
    // A panel domain under the managed zone selects the `*.<zone>` wildcard
    // resolver; its HETZNER_API_KEY env file is NOT written here (secrets
    // stay out of bootstrap SSH scripts shared with cloud-init) — the hosted
    // panel's reconciler delivers it within one tick of first boot, so
    // wildcard issuance may lag the health check by ~30s.
    onProgress("ingress", `Configuring reverse proxy for ${domain}...`);
    const useInternalTls = domain.endsWith(".nip.io");
    await deployTraefikPanelSite(
      serverIp,
      domain,
      hostPort,
      zoneName,
      hostKey || undefined,
    );

    // 11. Health check. The panel container binds to 127.0.0.1 (cloneAndBuild
    // default), and the host Traefik reaches it via localhost, so we probe
    // the same address here.
    onProgress("health", "Checking panel health...");
    const health = await healthCheck(
      serverIp,
      opts.appName,
      "127.0.0.1",
      hostPort,
      5,
      hostKey || undefined,
    );
    if (!health.healthy) {
      throw new Error(`Panel health check failed: ${health.error || "unknown"}`);
    }

    // 12. Public reachability. The health check above only proves the container
    //     is up on the server's loopback — it says nothing about whether the
    //     operator can actually reach https://domain. For a real domain, Traefik
    //     cannot issue a Let's Encrypt cert until DNS points at the server, so
    //     verify that here and report it honestly instead of claiming success
    //     the operator can't act on. (.nip.io uses an internal cert and needs
    //     no public DNS, so it's considered reachable by construction.)
    let dnsResolved = useInternalTls;
    if (!useInternalTls) {
      onProgress("verify", "Verifying DNS points at the server...");
      dnsResolved = await checkDnsResolves(domain, serverIp);
      if (dnsResolved) {
        onProgress("verify", "DNS resolves; waiting for TLS certificate...");
        const httpsOk = await waitForHttps(domain, 6);
        if (!httpsOk) {
          onProgress(
            "verify",
            "TLS not ready yet — it will be issued automatically once the domain is reachable.",
          );
        }
      } else {
        onProgress(
          "verify",
          `${domain} does not resolve to ${serverIp} yet — create a DNS A record to finish.`,
        );
      }
    }

    log(
      "done",
      `Panel bootstrapped in ${((Date.now() - t0) / 1000).toFixed(1)}s → https://${domain}`,
    );
    onProgress("done", `Panel deployed: https://${domain}`);
    return {
      ok: true,
      domain: domain,
      serverIp,
      dnsAutoCreated: !!dnsRecordKey,
      dnsResolved,
      internalTls: useInternalTls,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Bootstrap failed: ${msg}`);
    onProgress("error", msg);

    // Rollback
    if (dnsRecordKey) {
      try {
        await dns.deleteRecord(dnsRecordKey);
      } catch (e) {
        log("error", `Rollback: failed to delete DNS record: ${e}`);
      }
    }
    if (volumeId) {
      try {
        await compute.volumes?.delete(volumeId);
      } catch (e) {
        log("error", `Rollback: failed to delete volume ${volumeId}: ${e}`);
      }
    }
    if (providerServerId) {
      try {
        await compute.deleteServer(providerServerId);
      } catch (e) {
        log("error", `Rollback: failed to delete server ${providerServerId}: ${e}`);
      }
    }
    if (dbServerId) {
      // Cascades to the panel row via FK ON DELETE CASCADE.
      try {
        db.deleteServer(dbServerId);
      } catch (e) {
        log("error", `Rollback: failed to delete DB server ${dbServerId}: ${e}`);
      }
    }

    return { ok: false, error: msg };
  }
}

/**
 * Derive the GHCR image reference for the panel from its git repo URL.
 *
 * The CD workflow pushes the panel image to `ghcr.io/<owner>/<repo>` (see
 * .github/workflows/cd.yml). GHCR requires the path to be lowercase, so we
 * lowercase the owner/repo we extract from the (mixed-case) git URL.
 * Accepts https, ssh (`git@github.com:owner/repo.git`), and trailing `.git`.
 */
export function ghcrImageForRepo(gitRepo: string, tag: string): string {
  const path = gitRepo
    .trim()
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const ownerRepo = path.split("/").filter(Boolean).slice(-2).join("/");
  return `ghcr.io/${ownerRepo.toLowerCase()}:${tag}`;
}

/**
 * Build the detached rebuild script for a panel self-redeploy.
 *
 * KEY CHANGE vs the old behaviour: this NO LONGER runs `docker build` on the
 * panel's own host. Building cross-compiled the CLI + re-ran bun install and
 * pegged both cores for minutes, starving the live panel (Traefik 502/503).
 * Instead we `docker pull` the image the CD workflow already built and pushed
 * to GHCR, then swap. Pulling is I/O-bound and the OLD container keeps serving
 * for the whole pull, so there is no CPU starvation — only a seconds-long swap.
 *
 * The pull is retried because the webhook that triggers a redeploy fires on
 * *push*, ~15 min BEFORE CI finishes publishing the image. We pull an
 * immutable per-commit tag (`sha-<gitsha>`); that tag only exists once CI has
 * built and pushed it, so retrying the pull inherently waits for "image ready"
 * without polling GitHub. If the image never appears (e.g. CI failed) we give
 * up and leave the currently-running container untouched (fail-safe).
 */
export function buildPanelRebuildScript(opts: {
  containerName: string;
  /** Full GHCR ref including tag, e.g. ghcr.io/owner/repo:sha-<...>. */
  image: string;
  hostPort: number;
  containerPort: number;
  envFilePath: string;
  /** "-v src:dst" or "". */
  volumeFlag: string;
  /** "DOCKER_CONFIG=<dir> " (trailing space) or "" for anonymous pulls. */
  ghcrEnvPrefix: string;
  /** Ephemeral DOCKER_CONFIG dir to remove when done, or "". */
  ghcrConfigDir: string;
  pullRetries: number;
  pullSleepSeconds: number;
}): string {
  const {
    containerName, image, hostPort, containerPort, envFilePath, volumeFlag,
    ghcrEnvPrefix, ghcrConfigDir, pullRetries, pullSleepSeconds,
  } = opts;
  const cleanup = ghcrConfigDir
    ? `su - deploy -c "rm -rf ${ghcrConfigDir}" 2>/dev/null || true`
    : `true`;
  // NB: no `set -e` — a failed pull attempt must not abort the retry loop.
  return [
    `#!/usr/bin/env bash`,
    `set -uo pipefail`,
    `pull_ok=0`,
    `for i in $(seq 1 ${pullRetries}); do`,
    `  if su - deploy -c "${ghcrEnvPrefix}docker pull ${image}"; then pull_ok=1; break; fi`,
    `  echo "[panel-redeploy] ${image} not ready (attempt $i/${pullRetries}); retrying in ${pullSleepSeconds}s"`,
    `  sleep ${pullSleepSeconds}`,
    `done`,
    `if [ "$pull_ok" != "1" ]; then`,
    `  echo "[panel-redeploy] giving up: ${image} never became available; leaving current container running"`,
    `  ${cleanup}`,
    `  exit 1`,
    `fi`,
    // Swap on the SAME loopback port that Traefik's panel.yml already targets.
    `docker rm -f ${containerName} 2>/dev/null || true`,
    `su - deploy -c "docker run -d --name ${containerName} --restart unless-stopped -p 127.0.0.1:${hostPort}:${containerPort} --env-file ${envFilePath} ${volumeFlag} ${image}"`,
    `${cleanup}`,
  ].join("\n");
}

/**
 * Best-effort GitHub token for pulling the (possibly private) panel image from
 * GHCR. The self-redeploy runs with no user context (it's fired by a webhook),
 * so there is no `deployed_by` to key on. Fall back to any linked account,
 * preferring admins. Returns "" when nobody has linked GitHub — in which case
 * we pull anonymously, which succeeds for a public GHCR package.
 */
async function resolvePanelGitHubToken(): Promise<string> {
  try {
    const users = [...db.getUsers()].sort(
      (a, b) => (b.is_admin ? 1 : 0) - (a.is_admin ? 1 : 0),
    );
    for (const u of users) {
      const tok = await resolveGitHubToken(u.id);
      if (tok) return tok;
    }
  } catch (err) {
    log("redeploy", `GitHub token resolution failed (continuing anonymous): ${err}`);
  }
  return "";
}

/**
 * Redeploy the hosted panel. This is called by the panel on itself, so
 * doing the rebuild inline would `docker rm -f` our own container mid-build
 * and the new container would never start. Instead we dispatch the rebuild
 * as a transient systemd unit on the host via SSH (truly fire-and-forget
 * with no lingering stdio fds for ssh to wait on) and return immediately.
 *
 * CRITICAL: All DB writes (status, deploy_log, panel_deployments) happen
 * BEFORE the SSH dispatch call. If we wrote them after, they would race
 * the `docker rm -f` in the rebuild script — the panel container would be
 * killed before the writes landed, and the hosted instance would come back
 * with status="deploying" forever and no deployment_history entry. Put
 * writes first, dispatch last.
 */
export async function redeployPanel(
  onProgress: ProgressFn,
  opts: { source?: string; gitCommit?: string; gitSha?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const source = opts.source ?? "manual";
  log("redeploy", `Redeploy requested (source=${source})`);

  const panel = db.getPanel();
  if (!panel) {
    return { ok: false, error: "Panel is not configured in this DB" };
  }
  const server = db.getServer(panel.server_id);
  if (!server) {
    return { ok: false, error: "Panel server not found" };
  }
  const hostKey = server.ssh_host_key || undefined;

  try {
    // Pick the image to pull. A webhook redeploy carries the pushed commit's
    // full SHA, so we pull the immutable per-commit tag (`sha-<gitsha>`) the CD
    // workflow emits — this pins us to the SAME commit and, because that tag
    // only exists once CI has published it, the pull-retry loop inherently
    // waits for the image to be ready. A manual redeploy has no SHA, so it
    // pulls `:latest` (the last successful default-branch build).
    const gitSha = opts.gitSha && /^[0-9a-f]{7,40}$/i.test(opts.gitSha) ? opts.gitSha : "";
    const tag = gitSha ? `sha-${gitSha}` : "latest";
    const image = ghcrImageForRepo(panel.git_repo, tag);

    // === All persistent state updates FIRST, before the dispatch SSH call ===
    onProgress("build", "Recording redeploy in DB...");
    db.appendPanelDeployLog(
      `[redeploy ${new Date().toISOString()}] ${source} redeploy dispatched (pull ${image})`,
    );
    db.insertPanelDeployment({
      image_tag: image,
      git_commit: opts.gitCommit || source,
      status: "deployed",
      source,
    });
    // Optimistic: the new container will reach running state via the
    // detached rebuild below. Nothing else updates panel.status, so write
    // "running" now while we still have a live DB handle.
    db.updatePanelStatus("running");

    // === GHCR auth: reuse the same ephemeral DOCKER_CONFIG login the app
    // deploy path uses. Best-effort — a public GHCR package pulls anonymously.
    // The login dir must OUTLIVE this call (the detached pull may retry for
    // minutes), so we do NOT clean it up here; the rebuild script removes it.
    let ghcrEnvPrefix = "";
    let ghcrConfigDir = "";
    const token = await resolvePanelGitHubToken();
    if (token && image.startsWith("ghcr.io/")) {
      try {
        const auth = await dockerLoginGhcr(server.ipv4, token, hostKey);
        ghcrEnvPrefix = auth.envPrefix;
        ghcrConfigDir = auth.dockerConfig;
      } catch (err) {
        log("redeploy", `ghcr login failed (falling back to anonymous pull): ${err}`);
      }
    }

    // === Build the rebuild script ===
    const appDir = `/home/deploy/apps/${panel.name}`;
    const envFilePath = `${appDir}/.env.deploy`;
    const volumeFlag = panel.volume_mount ? `-v ${panel.volume_mount}` : "";
    // A webhook redeploy waits for CI (~15 min): retry ~30 min. A manual
    // redeploy pulls an already-built tag: retry briefly for registry blips.
    const pullRetries = gitSha ? 90 : 12;
    const pullSleepSeconds = gitSha ? 20 : 10;
    const rebuildScript = buildPanelRebuildScript({
      containerName: panel.name,
      image,
      hostPort: panel.host_port,
      containerPort: panel.container_port,
      envFilePath,
      volumeFlag,
      ghcrEnvPrefix,
      ghcrConfigDir,
      pullRetries,
      pullSleepSeconds,
    });

    // === Dispatch via systemd-run (true detach) ===
    // systemd-run --no-block starts a transient unit and returns immediately;
    // the unit is owned by systemd, not the SSH session, so `sshExec` does
    // not wait on the rebuild's lifetime.
    const unitName = `ocd-panel-redeploy-${Date.now()}`;
    const dispatch = [
      `set -e`,
      `cat > /tmp/${unitName}.sh <<'OCD_PANEL_EOF'`,
      rebuildScript,
      `OCD_PANEL_EOF`,
      `chmod +x /tmp/${unitName}.sh`,
      `systemd-run --unit=${unitName} --no-block --collect --property=StandardOutput=file:/tmp/${unitName}.log --property=StandardError=file:/tmp/${unitName}.log /bin/bash /tmp/${unitName}.sh`,
      `echo dispatched=${unitName}`,
    ].join("\n");

    onProgress("dispatch", "Dispatching detached rebuild via systemd-run...");
    const result = await sshExec(server.ipv4, dispatch, hostKey);
    if (result.exitCode !== 0) {
      // The DB writes already happened; roll back panel_deployments so the
      // history doesn't lie.
      throw new Error(`systemd-run dispatch failed: ${result.stderr || result.stdout}`);
    }

    log("redeploy", `Dispatched as systemd unit ${unitName}`);
    onProgress(
      "done",
      "Panel rebuild dispatched; the page will become unavailable briefly and then return on the new image.",
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Redeploy failed: ${msg}`);
    db.updatePanelStatus("error");
    db.appendPanelDeployLog(`[redeploy error] ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Fetch the last N lines of container logs from the hosted panel container.
 */
export async function getPanelContainerLogs(tail = 200): Promise<string> {
  const panel = db.getPanel();
  if (!panel) return "";
  const server = db.getServer(panel.server_id);
  if (!server) return "";
  return getContainerLogs(
    server.ipv4,
    panel.name,
    tail,
    server.ssh_host_key || undefined,
  );
}
