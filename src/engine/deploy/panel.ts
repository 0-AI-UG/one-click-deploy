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
import * as db from "../../shared/db.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import {
  sshExec, waitForServer, captureHostKey, getOrCreateLocalKeyPair,
  cloneAndBuild, deployCaddySite, healthCheck, getContainerLogs,
} from "../../shared/remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { handoffDbToVolume } from "./self-deploy.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [panel:${context}]`, ...args);
}

export type BootstrapPanelOpts = {
  appName: string;
  domain: string;
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
): Promise<{ ok: boolean; error?: string; domain?: string }> {
  const t0 = Date.now();
  log("start", `Bootstrapping panel ${opts.appName} → ${opts.domain}`);

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

    // 5. DNS (best-effort)
    if (opts.dnsZoneId) {
      try {
        const parts = opts.domain.split(".");
        const sub = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
        await dns.createRecord({
          zoneId: opts.dnsZoneId,
          name: sub,
          type: "A",
          value: serverIp,
        });
        dnsRecordKey = { zoneId: opts.dnsZoneId, name: sub, type: "A", value: serverIp };
        onProgress("dns", `DNS A record created: ${opts.domain} → ${serverIp}`);
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
    if (compute.id === "hetzner") {
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
    } else {
      await sshExec(
        serverIp,
        `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`,
        hostKey || undefined,
      );
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
      domain: opts.domain,
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
    db.appendPanelDeployLog(`[bootstrap] Panel deployed to ${opts.domain}`);

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

    // 10. Caddy + TLS
    onProgress("caddy", `Configuring reverse proxy for ${opts.domain}...`);
    const useInternalTls = opts.domain.endsWith(".nip.io");
    await deployCaddySite(
      serverIp,
      opts.domain,
      hostPort,
      useInternalTls,
      hostKey || undefined,
    );

    // 11. Health check. The panel container binds to 127.0.0.1 (cloneAndBuild
    // default), and the panel's own Caddy reaches it via localhost, so we
    // probe the same address here.
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

    log(
      "done",
      `Panel bootstrapped in ${((Date.now() - t0) / 1000).toFixed(1)}s → https://${opts.domain}`,
    );
    onProgress("done", `Panel deployed: https://${opts.domain}`);
    return { ok: true, domain: opts.domain };
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
  opts: { source?: string; gitCommit?: string } = {},
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
    // === All persistent state updates FIRST, before the dispatch SSH call ===
    onProgress("build", "Recording redeploy in DB...");
    db.appendPanelDeployLog(
      `[redeploy ${new Date().toISOString()}] ${source} redeploy dispatched`,
    );
    db.insertPanelDeployment({
      image_tag: `${panel.name}:latest`,
      git_commit: opts.gitCommit || source,
      status: "deployed",
      source,
    });
    // Optimistic: the new container will reach running state via the
    // detached rebuild below. Nothing else updates panel.status, so write
    // "running" now while we still have a live DB handle.
    db.updatePanelStatus("running");

    // === Build the rebuild script ===
    const appDir = `/home/deploy/apps/${panel.name}`;
    const envFilePath = `${appDir}/.env.deploy`;
    const volumeFlag = panel.volume_mount ? `-v ${panel.volume_mount}` : "";
    const rebuildScript = [
      `#!/usr/bin/env bash`,
      `set -euo pipefail`,
      `cd ${appDir}`,
      `su - deploy -c "cd ${appDir} && git pull"`,
      `su - deploy -c "cd ${appDir} && docker build -t ${panel.name}:latest ."`,
      `docker rm -f ${panel.name} 2>/dev/null || true`,
      `su - deploy -c "docker run -d --name ${panel.name} --restart unless-stopped -p 127.0.0.1:${panel.host_port}:${panel.container_port} --env-file ${envFilePath} ${volumeFlag} ${panel.name}:latest"`,
    ].join("\n");

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
