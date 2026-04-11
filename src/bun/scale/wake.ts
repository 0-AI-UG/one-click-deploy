import * as db from "../db.ts";
import {
  sshExec, composeHealthCheck, healthCheck, deployAuthProxy,
  startContainer, startCompose, containerExists, composeProjectExists,
  getOrCreateLocalKeyPair, waitForServer, captureHostKey, removePanelWakePage,
} from "../remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { syncAppCaddy } from "./caddy-manager.ts";
import { log, type Server, replicaBindHost } from "./types.ts";
import { cancelFreezeForServer } from "./freeze-worker.ts";
import { getComputeProvider, getDnsProvider } from "../providers/index.ts";

// Per-server in-memory lock for the wake-from-deep-sleep materialization step.
// Two concurrent wakes for apps on the same frozen server collapse into one
// provider call instead of racing to create two instances. The map key is the
// server row id; the promise resolves to the freshly materialized server row.
// The entry is cleared when the promise settles so a subsequent wake (after a
// future freeze) can re-materialize.
const materializeLocks = new Map<number, Promise<Server>>();

export async function wakeApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("wake", `Waking app ${appId}`);

  try {
    const app = db.getApp(appId);
    if (!app) return { ok: false, error: "App not found" };
    if (app.status !== "sleeping") return { ok: true }; // already awake or waking

    const serverId = app.sleeping_server_id;
    const hostPort = app.sleeping_host_port;
    if (!serverId || !hostPort) return { ok: false, error: "Missing sleeping state" };

    let server = db.getServer(serverId);
    if (!server) return { ok: false, error: "Server not found" };

    // Cancel any in-flight freeze job for this server. The worker guarantees
    // the server row is left "materialized" on cancel, so after this await
    // we can treat the server as still alive. A freeze that has already
    // advanced past `finalizing` cannot be cancelled — at that point the
    // server is frozen and we must go through the Phase 4 deep-wake path.
    await cancelFreezeForServer(server.id);
    server = db.getServer(serverId);
    if (!server) return { ok: false, error: "Server not found" };

    db.updateAppStatus(appId, "waking");

    // Deep wake: server was destroyed by a freeze job. Recreate it from the
    // stored snapshot, re-attach the frozen volumes, wait for boot, then fall
    // through to the shared light-wake flow below (the container is in the
    // snapshot image so `docker start` still works).
    let deepWaked = false;
    let oldSnapshotId = "";
    if (server.state === "frozen") {
      oldSnapshotId = server.snapshot_id;
      try {
        server = await materializeServer(serverId) as typeof server;
        deepWaked = true;
        log("wake", `App ${appId}: deep wake — server ${serverId} materialized ipv4=${server.ipv4}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("wake", `deep wake failed: ${msg}`);
        db.updateAppStatus(appId, "error");
        return { ok: false, error: msg };
      }
    }
    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const containerName = app.name;

    // Prefer the fast path: if the replica was preserved on disk by
    // scale-down (Phase 0), the container/compose project still exists and
    // we can bring it back up with `docker start` in ~1s instead of a fresh
    // `docker run` that has to (re)create everything.
    let startedFastPath = false;
    if (app.deploy_mode === "compose") {
      if (await composeProjectExists(server.ipv4, app.name, hostKey)) {
        try {
          await startCompose(server.ipv4, app.name, hostKey);
          startedFastPath = true;
          log("wake", `App ${appId}: light wake via 'docker compose start'`);
        } catch (err) {
          // Fall through to the slow path (full `compose up -d`). The
          // compose stack may have been removed out-of-band.
          log("wake", `compose start failed, falling back to 'compose up -d': ${err}`);
        }
      }
    } else {
      if (await containerExists(server.ipv4, containerName, hostKey)) {
        try {
          const ok = await startContainer(server.ipv4, containerName, hostKey);
          if (ok) {
            startedFastPath = true;
            log("wake", `App ${appId}: light wake via 'docker start'`);
          }
        } catch (err) {
          log("wake", `docker start failed, falling back to 'docker run': ${err}`);
        }
      }
    }

    const bindAddr = replicaBindHost(server);

    // Slow path: full re-run. Only taken when the container/compose project
    // is not on disk — e.g. a restored snapshot that lost state, or a
    // pre-Phase-0 sleep where scale-down did `docker rm -f`.
    if (!startedFastPath) {
      if (app.deploy_mode === "compose") {
        await sshExec(server.ipv4, asUser(
          `cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`
        ), hostKey);
      } else {
        const envVars = JSON.parse(app.env_vars || "{}");
        let envFileFlag = "";
        if (Object.keys(envVars).length > 0) {
          envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
        }
        const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
        const cmd = `docker run -d --name ${containerName} --restart unless-stopped ` +
          `-p ${bindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
        await sshExec(server.ipv4, asUser(cmd), hostKey);
      }
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(server.ipv4, app.name, bindAddr, hostPort, 5, hostKey)
      : await healthCheck(server.ipv4, containerName, bindAddr, hostPort, 5, hostKey);

    // Re-deploy auth proxy only on the slow path. The fast path preserved
    // the auth proxy systemd unit when the container was stopped.
    if (app.auth_password && !startedFastPath) {
      await deployAuthProxy(server.ipv4, containerName, app.auth_password, hostPort, hostKey);
    }

    // Install the panel Caddy vhost that fans out to this replica.
    // Note: the replica record below is inserted/upserted after this call,
    // so the Caddy upstream list picks up the fresh upstream on the next
    // line. syncAppCaddy is idempotent; a second call after the replica
    // flip below is harmless.

    // Upsert the replica row. On the fast path a preserved row already
    // exists (status = 'stopped') — flip it back to running. On the slow
    // path (no preserved row) insert fresh.
    const preserved = db
      .getReplicasByServer(serverId)
      .find((r) => r.app_id === appId && r.container_name === containerName);
    if (preserved) {
      if (health.healthy) {
        db.markReplicaRunning(preserved.id);
      } else {
        db.updateReplicaStatus(preserved.id, "unhealthy");
      }
    } else {
      db.insertReplica({
        app_id: appId,
        server_id: serverId,
        host_port: hostPort,
        container_name: containerName,
        status: health.healthy ? "running" : "unhealthy",
      });
    }

    // Clear sleeping state
    db.clearAppSleepingState(appId);
    db.updateAppScaling(appId, { desired_replicas: 1, last_scale_at: new Date().toISOString() });
    db.updateAppStatus(appId, "running");
    db.insertScalingEvent({ app_id: appId, event_type: "wake", from_count: 0, to_count: 1, reason: "wake request" });

    // Reinstall the panel Caddy vhost so public traffic is routed back to
    // the replica (instead of the tenant-server wake page that was
    // serving 503s while the app was asleep).
    try {
      await syncAppCaddy(appId);
    } catch (err) {
      log("wake", `syncAppCaddy after wake failed: ${err}`);
    }

    // Phase 5 handoff cleanup. If the wake page for this app currently
    // lives on the panel server — either because the server was just
    // deep-woken, or because a sibling app triggered a deep-wake earlier
    // and this is a "light sleep on panel" sibling catching up — we need
    // to (a) swap DNS back to the now-live tenant server and (b) remove
    // the wake page route from the panel's Caddy. The flag is the single
    // source of truth for "this app's wake page is on the panel right now",
    // set by the freeze worker and cleared here.
    const onPanel = app.wake_page_on_panel === 1;
    if ((deepWaked || onPanel) && health.healthy) {
      // DNS swap to the tenant server IP — no-op if already pointing at it.
      await swapDnsForApp(app, server.ipv4);
      // Remove the route from the panel's Caddy. Best-effort: failure here
      // leaves a stale route, which is harmless because the ask endpoint
      // won't authorize it once the flag is cleared (so no new certs are
      // minted) and the next freeze overwrites it anyway.
      if (onPanel) {
        try {
          const panel = db.getPanel();
          const panelServer = panel ? db.getServer(panel.server_id) : null;
          if (panelServer?.ipv4) {
            await removePanelWakePage(
              panelServer.ipv4,
              app.domain,
              panelServer.ssh_host_key || undefined,
            );
          }
          db.setAppWakePageOnPanel(appId, false);
        } catch (err) {
          log("wake", `panel wake page cleanup failed (continuing): ${err}`);
        }
      }
    }
    if (deepWaked && health.healthy) {
      if (oldSnapshotId) {
        try {
          const compute = getComputeProvider(server.provider);
          await compute.snapshots?.delete(oldSnapshotId);
          db.clearServerSnapshot(serverId);
          log("wake", `Old snapshot ${oldSnapshotId} deleted after successful deep wake`);
        } catch (err) {
          // Leave the snapshot id on the row so the next freeze / admin can
          // retry the cleanup. The row is materialized so nothing else blocks.
          log("wake", `snapshot cleanup failed (continuing): ${err}`);
        }
      }
    }

    log("wake", `App ${appId} woken successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("wake", `Failed to wake app ${appId}: ${msg}`);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}

/**
 * Re-create a frozen server from its stored snapshot, re-attach the frozen
 * volumes, and wait until SSH is ready. Dedupes concurrent callers per
 * server id via `materializeLocks` so two apps waking simultaneously collapse
 * into one provider round-trip.
 *
 * Returns the updated server row (state = "materialized", new provider_id /
 * ipv4). Throws on any provider error; callers should update app status and
 * surface the error to the UI.
 */
async function materializeServer(serverId: number): Promise<Server> {
  const existing = materializeLocks.get(serverId);
  if (existing) return existing;

  const promise = (async (): Promise<Server> => {
    const row = db.getServer(serverId);
    if (!row) throw new Error(`Server ${serverId} not found`);
    // Another caller may have already materialized the server between the
    // time wake.ts read `state === "frozen"` and when we took the lock.
    if (row.state !== "frozen") return row as Server;

    if (!row.snapshot_id) {
      throw new Error(`Server ${row.name} is frozen but has no snapshot_id on record`);
    }

    const compute = getComputeProvider(row.provider);
    if (!compute.snapshots) {
      throw new Error(
        `Server is frozen on provider "${row.provider}" which does not support snapshot restore. Manual intervention required.`,
      );
    }

    const volumeIds = db.getFrozenVolumeIds(row);
    const { publicKey } = await getOrCreateLocalKeyPair();
    const [sshKey, firewallId, networkId] = await Promise.all([
      compute.ensureSshKey("one-click-deploy", publicKey),
      compute.ensureFirewall(),
      ensureSharedNetwork(),
    ]);

    log("wake", `Materializing server ${row.name} from snapshot ${row.snapshot_id} (volumes=[${volumeIds.join(",")}])`);
    const providerServer = await compute.snapshots.createServerFromSnapshot({
      name: row.name,
      snapshotId: row.snapshot_id,
      serverType: row.type,
      location: row.location,
      sshKeyName: sshKey.name,
      firewallId,
      volumeIds,
      networkId: networkId || undefined,
    });

    // Wait until the provider reports the VM is running, then until SSH +
    // cloud-init have settled. For snapshot restores the provisioned flag is
    // already in the snapshot so waitForServer returns as soon as sshd is up.
    await compute.waitForRunning(providerServer.providerId);
    await waitForServer(providerServer.ipv4, 30);

    const newHostKey = await captureHostKey(providerServer.ipv4);
    db.markServerMaterialized(serverId, {
      provider_id: providerServer.providerId,
      ipv4: providerServer.ipv4,
      ipv6: providerServer.ipv6,
      private_ipv4: providerServer.privateIpv4 || "",
    });
    if (newHostKey) db.updateServerHostKey(serverId, newHostKey);

    const updated = db.getServer(serverId);
    if (!updated) throw new Error(`Server ${serverId} disappeared during materialize`);
    return updated as Server;
  })().finally(() => {
    materializeLocks.delete(serverId);
  });

  materializeLocks.set(serverId, promise);
  return promise;
}

/**
 * After a deep wake, point the app's A records at the new server IP. Each
 * record is swapped create-new → delete-old so there's no gap where the name
 * has no A record at all. Failures are logged but don't fail the wake —
 * stale DNS is recoverable, a failed wake is not.
 */
async function swapDnsForApp(
  app: { id: number; domain: string },
  newIpv4: string,
): Promise<void> {
  const records = db.getDnsRecords(app.id).filter((r) => r.type === "A");
  if (records.length === 0) return;
  const dns = getDnsProvider();
  for (const record of records) {
    if (record.value === newIpv4) continue;
    try {
      const created = await dns.createRecord({
        zoneId: record.zone_id,
        name: record.name,
        type: "A",
        value: newIpv4,
      });
      db.insertDnsRecord({
        app_id: app.id,
        zone_id: record.zone_id,
        record_id: created.id,
        name: record.name,
        type: "A",
        value: newIpv4,
      });
      try {
        await dns.deleteRecord({
          zoneId: record.zone_id,
          name: record.name,
          type: "A",
          value: record.value,
        });
      } catch (err) {
        log("wake", `DNS old record delete failed (continuing): ${err}`);
      }
      db.deleteDnsRecord(record.record_id);
      log("wake", `DNS swapped: ${app.domain} -> ${newIpv4}`);
    } catch (err) {
      log("wake", `DNS swap failed for record ${record.record_id}: ${err}`);
    }
  }
}
