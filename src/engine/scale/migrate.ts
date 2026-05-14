import * as db from "../../shared/db.ts";
import { sshExec, removeAuthProxy } from "../../shared/remote/index.ts";
import { syncAppCaddy } from "./caddy-manager.ts";
import { scaleUp } from "./scale-up.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";

const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

/**
 * Migrate a single replica from its current server to a target server.
 *
 * Stateless apps: scale up by 1 onto the target, then drain and remove the old replica
 * (zero downtime — net replica count stays the same).
 *
 * Apps with a persistent volume: stop on source, move the Hetzner volume to the target,
 * then start a fresh replica on the target. Brief downtime is unavoidable because a
 * volume can only be attached to one server at a time.
 */
export type MigrateResult =
  | { ok: true; sourceServerName: string; targetServerName: string; fromCount: number; toCount: number; withVolume?: boolean }
  | { ok: false; error: string };

export async function migrateReplica(
  appId: number,
  replicaId: number,
  targetServerId: number,
  emit: ProgressFn,
): Promise<MigrateResult> {
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

    const sourceServer = db.getServer(replica.server_id);
    if (!sourceServer) throw new Error("Source server not found");

    if (app.volume_id) {
      return await migrateWithVolume(app, replica, allReplicas, sourceServer, targetServer, emit);
    }
    return await migrateStateless(app, replica, allReplicas, sourceServer, targetServer, emit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("migrate", `Failed to migrate replica ${replicaId}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function migrateStateless(
  app: App,
  replica: Replica,
  allReplicas: Replica[],
  sourceServer: ReturnType<typeof db.getServer>,
  targetServer: ReturnType<typeof db.getServer>,
  emit: ProgressFn,
): Promise<MigrateResult> {
  if (!sourceServer || !targetServer) throw new Error("Server not found");
  const currentCount = allReplicas.length;
  const hostKey = sourceServer.ssh_host_key || undefined;

  emit("migrate", `Creating new replica on ${targetServer.name}...`);
  await scaleUp(app, allReplicas, currentCount, currentCount + 1, emit, targetServer.id);

  emit("migrate", `Draining old replica ${replica.container_name}...`);
  db.updateReplicaStatus(replica.id, "draining");
  try {
    await syncAppCaddy(app.id);
  } catch (err) {
    log("migrate", `Caddy sync during drain failed (continuing): ${err}`);
  }

  emit("migrate", `Waiting 10s drain for ${replica.container_name}...`);
  await Bun.sleep(10_000);

  if (app.deploy_mode === "compose" && replica.container_name === app.name) {
    // Primary compose instance — leave the on-disk project; just stop the container.
  } else {
    // Graceful stop first so SQLite WAL and other buffered writers flush.
    // `docker stop -t 20` sends SIGTERM, waits up to 20s, then SIGKILL.
    await sshExec(sourceServer.ipv4, asUser(`docker stop -t 20 ${replica.container_name} 2>/dev/null || true`), hostKey);
    await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
  }

  if (app.auth_password) {
    try {
      await removeAuthProxy(sourceServer.ipv4, replica.container_name, hostKey);
    } catch (err) {
      log("migrate", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
    }
  }

  db.deleteReplica(replica.id);
  emit("migrate", `Old replica ${replica.container_name} removed`);

  await syncAppCaddy(app.id);

  db.updateAppScaling(app.id, {
    desired_replicas: currentCount,
    last_scale_at: new Date().toISOString(),
  });

  try {
    await db.gcServerIfEmpty(sourceServer.id);
  } catch (err) {
    log("migrate", `Failed to gc server ${sourceServer.id}: ${err}`);
  }

  emit("migrate", `Migration complete — replica now on ${targetServer.name}`);
  return { ok: true, sourceServerName: sourceServer.name, targetServerName: targetServer.name, fromCount: currentCount, toCount: currentCount };
}

async function migrateWithVolume(
  app: App,
  replica: Replica,
  allReplicas: Replica[],
  sourceServer: NonNullable<ReturnType<typeof db.getServer>>,
  targetServer: NonNullable<ReturnType<typeof db.getServer>>,
  emit: ProgressFn,
): Promise<MigrateResult> {
  if (sourceServer.location !== targetServer.location) {
    throw new Error(
      `Cannot migrate: volume lives in ${sourceServer.location}, target server is in ${targetServer.location}. Hetzner volumes are bound to a single location.`,
    );
  }

  const compute = getComputeProvider();
  if (!compute.volumes) throw new Error("Compute provider does not support volumes");

  const sourceHostKey = sourceServer.ssh_host_key || undefined;
  const targetHostKey = targetServer.ssh_host_key || undefined;
  const currentCount = allReplicas.length;
  const volumeId = app.volume_id;

  // Stop routing to the old replica and bring its container down. Volume migration
  // requires the source container to release the mount before Hetzner will detach.
  emit("migrate", `Stopping ${replica.container_name} on ${sourceServer.name}...`);
  db.updateReplicaStatus(replica.id, "draining");
  try {
    await syncAppCaddy(app.id);
  } catch (err) {
    log("migrate", `Caddy sync during drain failed (continuing): ${err}`);
  }

  // Graceful stop so SQLite WAL and other buffered writers flush before the
  // volume is detached. compose down sends SIGTERM then SIGKILL (10s default);
  // docker stop -t 20 gives single containers a 20s grace window.
  if (app.deploy_mode === "compose" && replica.container_name === app.name) {
    await sshExec(sourceServer.ipv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose down -t 20 2>/dev/null || true`), sourceHostKey);
  } else {
    await sshExec(sourceServer.ipv4, asUser(`docker stop -t 20 ${replica.container_name} 2>/dev/null || true`), sourceHostKey);
    await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), sourceHostKey);
  }

  if (app.auth_password) {
    try {
      await removeAuthProxy(sourceServer.ipv4, replica.container_name, sourceHostKey);
    } catch (err) {
      log("migrate", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
    }
  }

  emit("migrate", `Detaching volume from ${sourceServer.name}...`);
  await compute.volumes.detach(volumeId);

  emit("migrate", `Attaching volume to ${targetServer.name}...`);
  try {
    await compute.volumes.attach(volumeId, targetServer.provider_id);
  } catch (attachErr) {
    log("migrate", `Attach to target failed, attempting rollback to source: ${attachErr}`);
    try {
      await compute.volumes.attach(volumeId, sourceServer.provider_id);
      log("migrate", `Volume rolled back to source ${sourceServer.name}`);
    } catch (rollbackErr) {
      log("migrate", `Rollback attach also failed — volume left detached: ${rollbackErr}`);
    }
    throw attachErr;
  }

  // Ensure the host mount path exists on the target. Convention matches
  // handleReattachVolume in src/server/routes/volumes.ts.
  const hostMountPath = `/mnt/ocd-${app.name}-data`;
  await sshExec(targetServer.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, targetHostKey);

  // Persist the canonical mount string so deploy/scale paths see the same value
  // they would after a fresh attach. Container path defaults to /data when missing
  // (mirrors handleReattachVolume).
  const containerPath = (app.volume_mount?.split(":")[1]) || "/data";
  const newVolumeMount = `${hostMountPath}:${containerPath}`;
  if (newVolumeMount !== app.volume_mount) {
    db.updateAppVolume(app.id, volumeId, newVolumeMount);
    app.volume_mount = newVolumeMount;
  }

  // Start the new replica on the target. We keep the old replica row in the DB
  // until scaleUp succeeds so it can serve as the "primary" for image transfer.
  emit("migrate", `Starting ${app.name} on ${targetServer.name}...`);
  try {
    await scaleUp(app, allReplicas, currentCount, currentCount + 1, emit, targetServer.id);
  } catch (scaleErr) {
    log("migrate", `Failed to start replica on target after volume move: ${scaleErr}`);
    throw scaleErr;
  }

  // Now safe to drop the old replica row.
  db.deleteReplica(replica.id);

  await syncAppCaddy(app.id);

  db.updateAppScaling(app.id, {
    desired_replicas: currentCount,
    last_scale_at: new Date().toISOString(),
  });

  try {
    await db.gcServerIfEmpty(sourceServer.id);
  } catch (err) {
    log("migrate", `Failed to gc server ${sourceServer.id}: ${err}`);
  }

  emit("migrate", `Migration complete — replica and volume now on ${targetServer.name}`);
  return { ok: true, sourceServerName: sourceServer.name, targetServerName: targetServer.name, fromCount: currentCount, toCount: currentCount, withVolume: true };
}
