import * as db from "../db.ts";
import { sshExec, removeAuthProxy } from "../remote/index.ts";
import { syncAppCaddy } from "./caddy-manager.ts";
import { scaleUp } from "./scale-up.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";

/**
 * Migrate a single replica from its current server to a target server.
 *
 * Strategy: scale up by 1 onto the target, then drain and remove the old replica.
 * Net replica count stays the same (desired_replicas is restored).
 */
export async function migrateReplica(
  appId: number,
  replicaId: number,
  targetServerId: number,
  emit: ProgressFn,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const app = db.getApp(appId) as App | null;
    if (!app) throw new Error("App not found");

    const allReplicas = db.getReplicas(appId) as Replica[];
    const replica = allReplicas.find((r) => r.id === replicaId);
    if (!replica) throw new Error("Replica not found");

    if (replica.server_id === targetServerId) {
      throw new Error("Replica is already on the target server");
    }

    const targetServer = db.getServer(targetServerId);
    if (!targetServer || targetServer.status !== "ready") {
      throw new Error("Target server not found or not ready");
    }

    if (app.volume_id) {
      throw new Error("Apps with persistent storage cannot be migrated — volumes are bound to a single server");
    }

    const currentCount = allReplicas.length;

    // Step 1: Scale up by 1 onto the target server
    emit("migrate", `Creating new replica on ${targetServer.name}...`);
    await scaleUp(app, allReplicas, currentCount, currentCount + 1, emit, targetServerId);

    // Step 2: Drain and remove the old replica
    emit("migrate", `Draining old replica ${replica.container_name}...`);
    const sourceServer = db.getServer(replica.server_id);
    if (!sourceServer) throw new Error("Source server not found");
    const hostKey = sourceServer.ssh_host_key || undefined;

    // Mark draining and sync Caddy to stop sending new traffic
    db.updateReplicaStatus(replica.id, "draining");
    try {
      await syncAppCaddy(app.id);
    } catch (err) {
      log("migrate", `Caddy sync during drain failed (continuing): ${err}`);
    }

    emit("migrate", `Waiting 10s drain for ${replica.container_name}...`);
    await Bun.sleep(10_000);

    // Remove old container
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    if (app.deploy_mode === "compose" && replica.container_name === app.name) {
      // Primary compose instance — just stop, don't rm
    } else {
      await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
    }

    // Remove auth proxy if present
    if (app.auth_password) {
      try {
        await removeAuthProxy(sourceServer.ipv4, replica.container_name, hostKey);
      } catch (err) {
        log("migrate", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
      }
    }

    db.deleteReplica(replica.id);
    emit("migrate", `Old replica ${replica.container_name} removed`);

    // Sync Caddy with final state
    await syncAppCaddy(app.id);

    // Restore desired_replicas to the original count (net zero change)
    db.updateAppScaling(appId, {
      desired_replicas: currentCount,
      last_scale_at: new Date().toISOString(),
    });

    db.insertScalingEvent({
      app_id: appId,
      event_type: "migrate",
      from_count: currentCount,
      to_count: currentCount,
      reason: `Migrated replica from ${sourceServer.name} to ${targetServer.name}`,
    });

    // GC source server if empty
    try {
      await db.gcServerIfEmpty(sourceServer.id);
    } catch (err) {
      log("migrate", `Failed to gc server ${sourceServer.id}: ${err}`);
    }

    emit("migrate", `Migration complete — replica now on ${targetServer.name}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("migrate", `Failed to migrate replica ${replicaId}: ${msg}`);
    return { ok: false, error: msg };
  }
}
