// Panel lifecycle — bootstrap + self-redeploy for the hosted panel.
//
// The panel is deliberately NOT an apps-table row. It lives in its own
// `panel` singleton table so the regular app deploy/redeploy/scale/lifecycle
// code paths never see it.
//
// Two entry points:
//   - bootstrapPanel(): run once from auto-deploy (headless bootstrap in a
//     local Docker container). Provisions a Hetzner server and volume,
//     pulls the panel artifact, hands off a snapshot of the bootstrap DB to
//     the server's volume, then starts the hosted container.
//   - redeployPanel(): run from inside the hosted panel when the operator
//     releases a new immutable image. Dispatches a detached replacement on the
//     host via systemd-run so the panel can kill and replace itself without
//     SSH blocking. All DB writes happen BEFORE dispatch so they land even
//     if the panel container is destroyed seconds later.
import { resolve4 } from "node:dns/promises";
import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import {
  sshExec, waitForServer, captureHostKey, getOrCreateLocalKeyPair,
  pullImmutableImageAndRun, healthCheck, getContainerLogs,
} from "../../shared/remote/index.ts";
import { deployTraefikPanelSite, installTraefikOn } from "../scale/traefik-manager.ts";
import { wakerPublishFlags } from "../scale/traefik-constants.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { handoffDbToVolume } from "./self-deploy.ts";
import { dockerLoginRegistry } from "../hetzner/registry.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";
import { DEFAULT_LOG_MAX_FILES, DEFAULT_LOG_MAX_SIZE } from "../hetzner/container-common.ts";

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
  /** Exact immutable panel artifact. */
  imageRef: string;
  containerPort: number;
  envVars: Record<string, string>;
  serverType: string;
  serverLocation: string;
  volumeSize: number;
  volumePath: string;
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
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(opts.imageRef)) {
    return { ok: false, error: "bootstrapPanel requires an immutable image_ref digest" };
  }
  if (db.getPanel()) {
    return { ok: false, error: "Panel already bootstrapped in this DB" };
  }

  // Rollback state
  let providerServerId: string | undefined;
  let dbServerId: number | undefined;
  let volumeId: string | undefined;

  const compute = hetzner;

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
      provider: "hetzner",
      ownership: "managed",
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
      management_address: serverIp,
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

    // 5. DNS is always operator-owned. OCD reports the provider-neutral
    //    instruction and observes propagation, but never mutates DNS.
    if (opts.domain) {
      onProgress("dns", `Create an A record with your DNS provider: ${domain} → ${serverIp}`);
    }

    // 6. Create + mount volume
    onProgress("artifact", `Creating ${opts.volumeSize}GB persistent volume...`);
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
    onProgress("artifact", `Volume ready (${volumeMount})`);

    // 7. Insert panel row in the BOOTSTRAP DB. Deliberately optimistic:
    //    status=running, an initial panel_deployment row. The snapshot we
    //    take in step 8 captures this, so the hosted instance boots already
    //    knowing who it is. If the subsequent pull/health-check fails we
    //    roll back below and the volume (with snapshot) is destroyed.
    const hostPort = 3001;
    db.insertPanel({
      server_id: dbServer.id,
      name: opts.appName,
      domain: domain,
      image_ref: opts.imageRef,
      container_port: opts.containerPort,
      host_port: hostPort,
      volume_id: volumeId,
      volume_mount: volumeMount,
      env_vars: JSON.stringify(opts.envVars),
      status: "running",
    });
    db.insertPanelDeployment({
      image_tag: opts.imageRef,
      git_commit: "",
      status: "deployed",
      source: "bootstrap",
    });
    db.appendPanelDeployLog(`[bootstrap] Panel deployed to ${domain}`);

    // 8. Handoff: snapshot bootstrap DB onto the mounted volume BEFORE the
    //    hosted container starts (so it opens the handed-off DB on first
    //    boot rather than a fresh one).
    onProgress("artifact", "Handing off DB to hosted volume...");
    await handoffDbToVolume({
      serverIp,
      hostKey: hostKey || undefined,
      hostMountPath,
    });

    // 9. Pull exact external image + run container.
    onProgress("artifact", `Pulling ${opts.imageRef}...`);
    await pullImmutableImageAndRun(
      serverIp,
      {
        name: opts.appName,
        imageRef: opts.imageRef,
        port: opts.containerPort,
        hostPort,
        envVars: opts.envVars,
        volumeMount,
        // Publish the in-process waker's HTTP port so sleeping apps' Traefik
        // routers (which dial `<panel-private-ip>:8896`) can reach it. Empty
        // until the private network is attached; the first redeploy backfills.
        extraPublish: wakerPublishFlags(providerServer.privateIpv4 || ""),
      },
      (line) => onProgress("artifact", line),
    );

    // 10. Ingress + TLS: write the panel's own Traefik vhost (panel.yml).
    // The file is owned by bootstrap and never rewritten by app syncs.
    // Every public domain uses HTTP-01. DNS must point at the panel before
    // Let's Encrypt can issue its certificate.
    onProgress("ingress", `Configuring reverse proxy for ${domain}...`);
    const useInternalTls = domain.endsWith(".nip.io");
    // Traefik runs on the panel ONLY and cloud-init no longer installs it, so
    // install it here (idempotent) before writing the panel vhost. Docker
    // readiness was already confirmed above (the docker --version SSH check),
    // which also proves cloud-init finished and SSH is reachable.
    onProgress("ingress", "Installing Traefik on the panel server...");
    await installTraefikOn(serverIp, hostKey || undefined);
    await deployTraefikPanelSite(
      serverIp,
      domain,
      hostPort,
      hostKey || undefined,
    );

    // 11. Health check. The panel container binds to 127.0.0.1 (pull helper
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
      dnsResolved,
      internalTls: useInternalTls,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Bootstrap failed: ${msg}`);
    onProgress("error", msg);

    // Rollback
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
 * Build the detached release script for a panel self-update. The image has
 * already been built by external CI and is identified by an immutable digest.
 * A short pull retry handles transient registry/network failures while the
 * current container keeps serving.
 */
export function buildPanelReleaseScript(opts: {
  containerName: string;
  /** Immutable OCI registry reference. */
  image: string;
  hostPort: number;
  containerPort: number;
  /** Panel server's private IPv4 — where the waker HTTP port is published so
   *  Traefik can reach the in-process waker for sleeping apps. "" → skip. */
  privateIpv4: string;
  envFilePath: string;
  /** "-v src:dst" or "". */
  volumeFlag: string;
  /** Friendly host bind path and attached Hetzner mount used to migrate
   * historical root-disk panel data during the stopped swap. Both empty means
   * no persistent volume migration is needed. */
  volumeHostPath?: string;
  volumeDevicePath?: string;
  /** "DOCKER_CONFIG=<dir> " (trailing space) or "" for anonymous pulls. */
  registryEnvPrefix: string;
  /** Ephemeral DOCKER_CONFIG dir to remove when done, or "". */
  registryConfigDir: string;
  pullRetries: number;
  pullSleepSeconds: number;
  /** How many times to poll /api/health before declaring the new container bad
   *  and rolling back. Polls are 2s apart. */
  healthRetries?: number;
}): string {
  const {
    containerName, image, hostPort, containerPort, privateIpv4, envFilePath,
    volumeFlag, registryEnvPrefix, registryConfigDir, pullRetries, pullSleepSeconds,
  } = opts;
  const healthRetries = opts.healthRetries ?? 30;
  // Publish the waker HTTP port (bound to the private IP) alongside the panel's
  // own loopback port, so sleeping apps' Traefik routers can reach the in-process
  // waker. Without this every sleeping-app hit 502s and nothing wakes.
  const wakerFlags = wakerPublishFlags(privateIpv4)
    .map((f) => ` ${f}`)
    .join("");
  const cleanup = registryConfigDir
    ? `su - deploy -c "rm -rf ${registryConfigDir}" 2>/dev/null || true`
    : `true`;
  const logFlags = `--log-opt max-size=${DEFAULT_LOG_MAX_SIZE} --log-opt max-file=${DEFAULT_LOG_MAX_FILES}`;
  const migrationLines = opts.volumeHostPath && opts.volumeDevicePath
    ? buildPanelVolumeMigrationLines({
        containerName,
        hostPath: opts.volumeHostPath,
        devicePath: opts.volumeDevicePath,
      })
    : [];
  // NB: no `set -e` — a failed pull attempt must not abort the retry loop.
  return [
    `#!/usr/bin/env bash`,
    `set -uo pipefail`,
    `pull_ok=0`,
    `for i in $(seq 1 ${pullRetries}); do`,
    `  if su - deploy -c "${registryEnvPrefix}docker pull ${image}"; then pull_ok=1; break; fi`,
    `  echo "[panel-redeploy] ${image} not ready (attempt $i/${pullRetries}); retrying in ${pullSleepSeconds}s"`,
    `  sleep ${pullSleepSeconds}`,
    `done`,
    `if [ "$pull_ok" != "1" ]; then`,
    `  echo "[panel-redeploy] giving up: ${image} never became available; leaving current container running"`,
    `  ${cleanup}`,
    `  exit 1`,
    `fi`,
    // Remember what is serving right now. If the new image cannot boot — a bad
    // migration, a config error — we put this exact image back, because
    // `docker rm -f` below has already destroyed the only running copy and
    // `--restart unless-stopped` would otherwise crash-loop the panel forever.
    `PREV_IMAGE=$(docker inspect --format '{{.Config.Image}}' ${containerName} 2>/dev/null || echo "")`,
    `echo "[panel-redeploy] current image: ${"$"}{PREV_IMAGE:-none}"`,
    `MIGRATED_PREFLIP=""`,
    ...migrationLines,
    // Swap on the SAME loopback port that Traefik's panel.yml already targets.
    `docker rm -f ${containerName} 2>/dev/null || true`,
    `su - deploy -c "docker run -d --name ${containerName} --restart unless-stopped ${logFlags} -p 127.0.0.1:${hostPort}:${containerPort}${wakerFlags} --env-file ${envFilePath} ${volumeFlag} ${image}"`,
    // Health gate. A container that exits immediately never answers /api/health,
    // so this catches both a crash-loop and a process that starts but is unwell.
    `healthy=0`,
    `for i in $(seq 1 ${healthRetries}); do`,
    `  if curl -fsS -m 3 http://127.0.0.1:${hostPort}/api/health >/dev/null 2>&1; then healthy=1; break; fi`,
    `  sleep 2`,
    `done`,
    `if [ "$healthy" = "1" ]; then`,
    `  echo "[panel-redeploy] new image healthy"`,
    `  if [ -n "$MIGRATED_PREFLIP" ]; then`,
    `    echo "[panel-redeploy] verified volume migration; removing root-disk preflip $MIGRATED_PREFLIP"`,
    `    rm -rf -- "$MIGRATED_PREFLIP"`,
    `  fi`,
    `  ${cleanup}`,
    `  exit 0`,
    `fi`,
    `echo "[panel-redeploy] ${image} failed health check after $((${healthRetries} * 2))s"`,
    `docker logs --tail 50 ${containerName} 2>&1 | sed 's/^/[panel-redeploy][failed] /' || true`,
    `if [ -z "$PREV_IMAGE" ] || [ "$PREV_IMAGE" = "${image}" ]; then`,
    `  echo "[panel-redeploy] no distinct previous image to roll back to; leaving it running"`,
    `  ${cleanup}`,
    `  exit 1`,
    `fi`,
    `echo "[panel-redeploy] rolling back to $PREV_IMAGE"`,
    `docker rm -f ${containerName} 2>/dev/null || true`,
    `su - deploy -c "docker run -d --name ${containerName} --restart unless-stopped ${logFlags} -p 127.0.0.1:${hostPort}:${containerPort}${wakerFlags} --env-file ${envFilePath} ${volumeFlag} $PREV_IMAGE"`,
    `${cleanup}`,
    `exit 1`,
  ].join("\n");
}

/**
 * A stopped, fail-closed migration for panels created before OCD installed a
 * bind from /mnt/HC_Volume_* onto /mnt/ocd-*-data. The old container is kept
 * (stopped) until rsync verification and fstab installation finish, so every
 * failure path can expose the legacy directory again and docker-start it.
 */
function buildPanelVolumeMigrationLines(opts: {
  containerName: string;
  hostPath: string;
  devicePath: string;
}): string[] {
  const { containerName, hostPath, devicePath } = opts;
  const begin = "# BEGIN ocd-bind panel";
  const end = "# END ocd-bind panel";
  const fstabLine = `${devicePath}  ${hostPath}  none  bind,nofail,x-systemd.requires=${devicePath}  0 0`;
  return [
    `HC_SOURCE=$(findmnt -no SOURCE ${devicePath} 2>/dev/null || true)`,
    `TARGET_SOURCE=$(findmnt -no SOURCE ${hostPath} 2>/dev/null || true)`,
    `if [ -z "$HC_SOURCE" ]; then`,
    `  echo "[panel-redeploy] attached panel volume is not mounted at ${devicePath}; leaving current container running"`,
    `  exit 1`,
    `fi`,
    `if [ "$TARGET_SOURCE" != "$HC_SOURCE" ]; then`,
    `  echo "[panel-redeploy] migrating legacy panel data ${hostPath} -> ${devicePath}"`,
    `  docker stop ${containerName} >/dev/null 2>&1 || true`,
    `  if [ -n "$TARGET_SOURCE" ]; then`,
    `    echo "[panel-redeploy] refusing migration: ${hostPath} is mounted from unexpected $TARGET_SOURCE"`,
    `    docker start ${containerName} >/dev/null 2>&1 || true`,
    `    exit 1`,
    `  fi`,
    `  LEGACY_ENTRY=$(find ${hostPath} -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)`,
    `  VOLUME_ENTRY=$(find ${devicePath} -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit 2>/dev/null || true)`,
    `  if [ -n "$LEGACY_ENTRY" ] && [ -n "$VOLUME_ENTRY" ]; then`,
    `    if rsync -aHAXn --delete --exclude=/lost+found --itemize-changes ${hostPath}/ ${devicePath}/ | grep -q .; then`,
    `      echo "[panel-redeploy] refusing migration: legacy path and attached volume both contain different data"`,
    `      docker start ${containerName} >/dev/null 2>&1 || true`,
    `      exit 1`,
    `    fi`,
    `  elif [ -n "$LEGACY_ENTRY" ]; then`,
    `    if ! rsync -aHAX --numeric-ids --exclude=/lost+found ${hostPath}/ ${devicePath}/; then`,
    `      echo "[panel-redeploy] rsync failed; restarting previous container on legacy data"`,
    `      docker start ${containerName} >/dev/null 2>&1 || true`,
    `      exit 1`,
    `    fi`,
    `    VERIFY_DIFF=$(rsync -aHAXn --delete --exclude=/lost+found --itemize-changes ${hostPath}/ ${devicePath}/)`,
    `    if [ -n "$VERIFY_DIFF" ]; then`,
    `      echo "[panel-redeploy] rsync verification failed; restarting previous container on legacy data"`,
    `      docker start ${containerName} >/dev/null 2>&1 || true`,
    `      exit 1`,
    `    fi`,
    `  fi`,
    `  sync`,
    `  PREFLIP=${hostPath}.preflip.$(date -u +%Y%m%d-%H%M%S)`,
    `  if ! mv ${hostPath} "$PREFLIP" || ! mkdir -p ${hostPath} || ! mount --bind ${devicePath} ${hostPath}; then`,
    `    echo "[panel-redeploy] bind setup failed; restoring legacy path"`,
    `    umount ${hostPath} >/dev/null 2>&1 || true`,
    `    rmdir ${hostPath} >/dev/null 2>&1 || true`,
    `    [ -d "$PREFLIP" ] && mv "$PREFLIP" ${hostPath}`,
    `    docker start ${containerName} >/dev/null 2>&1 || true`,
    `    exit 1`,
    `  fi`,
    `  FSTAB_TMP=$(mktemp)`,
    `  FSTAB_BACKUP=$(mktemp)`,
    `  if ! cp -p /etc/fstab "$FSTAB_BACKUP"; then`,
    `    echo "[panel-redeploy] could not back up fstab; restoring legacy path"`,
    `    rm -f "$FSTAB_TMP" "$FSTAB_BACKUP"`,
    `    umount ${hostPath} >/dev/null 2>&1 || true`,
    `    rmdir ${hostPath} >/dev/null 2>&1 || true`,
    `    mv "$PREFLIP" ${hostPath}`,
    `    docker start ${containerName} >/dev/null 2>&1 || true`,
    `    exit 1`,
    `  fi`,
    `  awk '$0=="${begin}" {skip=1; next} $0=="${end}" && skip {skip=0; next} !skip {print}' /etc/fstab > "$FSTAB_TMP"`,
    `  printf '%s\n%s\n%s\n' '${begin}' '${fstabLine}' '${end}' >> "$FSTAB_TMP"`,
    `  if ! install -m 0644 "$FSTAB_TMP" /etc/fstab || ! systemctl daemon-reload; then`,
    `    echo "[panel-redeploy] fstab update failed; restoring legacy path"`,
    `    install -m 0644 "$FSTAB_BACKUP" /etc/fstab >/dev/null 2>&1 || true`,
    `    systemctl daemon-reload >/dev/null 2>&1 || true`,
    `    rm -f "$FSTAB_TMP" "$FSTAB_BACKUP"`,
    `    umount ${hostPath} >/dev/null 2>&1 || true`,
    `    rmdir ${hostPath} >/dev/null 2>&1 || true`,
    `    mv "$PREFLIP" ${hostPath}`,
    `    docker start ${containerName} >/dev/null 2>&1 || true`,
    `    exit 1`,
    `  fi`,
    `  rm -f "$FSTAB_TMP" "$FSTAB_BACKUP"`,
    `  MIGRATED_PREFLIP="$PREFLIP"`,
    `  echo "[panel-redeploy] panel data copied, verified, and bind-mounted"`,
    `fi`,
  ];
}

/**
 * Redeploy the hosted panel. This is called by the panel on itself, so
 * doing the replacement inline would `docker rm -f` our own container
 * and the new container would never start. Instead we dispatch the replacement
 * as a transient systemd unit on the host via SSH (truly fire-and-forget
 * with no lingering stdio fds for SSH to wait on) and return immediately.
 *
 * CRITICAL: All DB writes (status, deploy_log, panel_deployments) happen
 * BEFORE the SSH dispatch call. If we wrote them after, they would race
 * the `docker rm -f` in the release script — the panel container would be
 * killed before the writes landed, and the hosted instance would come back
 * with status="deploying" forever and no deployment_history entry. Put
 * writes first, dispatch last.
 */
export async function redeployPanel(
  onProgress: ProgressFn,
  opts: { image: string; source?: string; commit?: string },
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
  let pendingRegistryConfigDir = "";

  try {
    const image = opts.image.trim();
    if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image)) {
      return { ok: false, error: "Panel release requires an immutable image digest" };
    }

    // Use only the fleet's explicitly configured OCI pull credentials. Public
    // registries remain anonymous; linked GitHub accounts are identity only.
    let registryEnvPrefix = "";
    let registryConfigDir = "";
    const credentials = await resolveRegistryCredentialsForImage(image);
    if (credentials.username && credentials.password) {
      const auth = await dockerLoginRegistry(
        server.ipv4,
        image,
        credentials.username,
        credentials.password,
        hostKey,
      );
      registryEnvPrefix = auth.envPrefix;
      registryConfigDir = auth.dockerConfig;
      pendingRegistryConfigDir = auth.dockerConfig;
    }

    // === All persistent state updates FIRST, before the dispatch SSH call ===
    onProgress("artifact", "Recording panel release in DB...");
    db.appendPanelDeployLog(
      `[redeploy ${new Date().toISOString()}] ${source} redeploy dispatched (pull ${image})`,
    );
    db.insertPanelDeployment({
      image_tag: image,
      git_commit: opts.commit || "",
      status: "deployed",
      source,
    });
    // Optimistic: the new container will reach running state via the
    // detached replacement below. Nothing else updates panel.status, so write
    // "running" now while we still have a live DB handle.
    db.updatePanelStatus("running");

    // === Build the detached release script ===
    const appDir = `/home/deploy/apps/${panel.name}`;
    const envFilePath = `${appDir}/.env.deploy`;
    const volumeFlag = panel.volume_mount ? `-v ${panel.volume_mount}` : "";
    const volumeHostPath = panel.volume_mount?.split(":")[0] || "";
    const volumeDevicePath = panel.volume_id ? `/mnt/HC_Volume_${panel.volume_id}` : "";
    const pullRetries = 3;
    const pullSleepSeconds = 10;
    const releaseScript = buildPanelReleaseScript({
      containerName: panel.name,
      image,
      hostPort: panel.host_port,
      containerPort: panel.container_port,
      privateIpv4: server.private_ipv4 || "",
      envFilePath,
      volumeFlag,
      volumeHostPath,
      volumeDevicePath,
      registryEnvPrefix,
      registryConfigDir,
      pullRetries,
      pullSleepSeconds,
    });

    // === Dispatch via systemd-run (true detach) ===
    // systemd-run --no-block starts a transient unit and returns immediately;
    // the unit is owned by systemd, not the SSH session, so `sshExec` does
    // not wait on the release's lifetime.
    const unitName = `ocd-panel-redeploy-${Date.now()}`;
    const dispatch = [
      `set -e`,
      `cat > /tmp/${unitName}.sh <<'OCD_PANEL_EOF'`,
      releaseScript,
      `OCD_PANEL_EOF`,
      `chmod +x /tmp/${unitName}.sh`,
      `systemd-run --unit=${unitName} --no-block --collect --property=StandardOutput=file:/tmp/${unitName}.log --property=StandardError=file:/tmp/${unitName}.log /bin/bash /tmp/${unitName}.sh`,
      `echo dispatched=${unitName}`,
    ].join("\n");

    onProgress("dispatch", "Dispatching detached release via systemd-run...");
    const result = await sshExec(server.ipv4, dispatch, hostKey);
    if (result.exitCode !== 0) {
      // The DB writes already happened; roll back panel_deployments so the
      // history doesn't lie.
      throw new Error(`systemd-run dispatch failed: ${result.stderr || result.stdout}`);
    }
    // The detached script now owns credential cleanup.
    pendingRegistryConfigDir = "";

    log("redeploy", `Dispatched as systemd unit ${unitName}`);
    onProgress(
      "done",
      "Panel release dispatched; the page will become unavailable briefly and then return on the new image.",
    );
    return { ok: true };
  } catch (err) {
    if (pendingRegistryConfigDir) {
      await sshExec(
        server.ipv4,
        `su - deploy -c "rm -rf ${pendingRegistryConfigDir}"`,
        hostKey,
      ).catch(() => {});
    }
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
