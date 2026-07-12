import * as db from "../../shared/db.ts";
import { sshExec, removeAuthProxy, ensureOcdNetwork, buildDockerRunArgs } from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { scaleUp } from "./scale-up.ts";
import { type ProgressFn, log, type App, type Replica, replicaBindHost } from "./types.ts";
import { hetzner } from "../../shared/providers/index.ts";

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

// Populated by migrateWithVolume as it advances so the saga's compensate hook
// can undo whichever destructive steps had already completed. All fields optional;
// presence indicates the action ran and may need reversal.
export type VolumeMigrationContext = {
  withVolume?: boolean;
  app?: App;
  replica?: Replica;
  sourceServer?: NonNullable<ReturnType<typeof db.getServer>>;
  targetServer?: NonNullable<ReturnType<typeof db.getServer>>;
  sourceContainerDestroyed?: boolean;
  volumeDetachedFromSource?: boolean;
  volumeAttachedToTarget?: boolean;
  originalVolumeMount?: string;
  volumeMountChanged?: boolean;
};

export async function migrateReplica(
  appId: number,
  replicaId: number,
  targetServerId: number,
  emit: ProgressFn,
  rollbackCtx?: VolumeMigrationContext,
): Promise<MigrateResult> {
  try {
    const app = db.getApp(appId) as App | null;
    if (!app) throw new Error("App not found");

    const targetServer = db.getServer(targetServerId);
    if (!targetServer || targetServer.status !== "ready") {
      throw new Error("Target server not found or not ready");
    }

    const allReplicas = db.getReplicas(appId) as Replica[];
    const replica = allReplicas.find((r) => r.id === replicaId);

    // Idempotent-success probe: on saga retry after a successful migration that
    // failed to finalize, the old replica row is gone. If a replica for this app
    // already lives on the target (and the volume too, when applicable), treat
    // the migration as already done.
    if (!replica) {
      const onTarget = allReplicas.filter((r) => r.server_id === targetServerId);
      if (onTarget.length > 0) {
        if (app.volume_id) {
          const compute = hetzner;
          if (compute.volumes) {
            try {
              const info = await compute.volumes.get(app.volume_id);
              if (info.serverId !== targetServer.provider_id) {
                throw new Error(
                  `Corrupted migration state: replica ${replicaId} is gone but volume is on ${info.serverId ?? "<detached>"}, not target ${targetServer.provider_id}`,
                );
              }
            } catch (err) {
              throw err instanceof Error ? err : new Error(String(err));
            }
          }
        }
        const count = allReplicas.length;
        log("migrate", `Replica ${replicaId} already migrated to ${targetServer.name} on a prior attempt — returning success`);
        return {
          ok: true,
          sourceServerName: targetServer.name,
          targetServerName: targetServer.name,
          fromCount: count,
          toCount: count,
          withVolume: !!app.volume_id,
        };
      }
      throw new Error("Replica not found");
    }

    if (replica.server_id === targetServerId) {
      throw new Error("Replica is already on the target server");
    }

    const sourceServer = db.getServer(replica.server_id);
    if (!sourceServer) throw new Error("Source server not found");

    if (app.volume_id) {
      return await migrateWithVolume(app, replica, allReplicas, sourceServer, targetServer, emit, rollbackCtx);
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
    await syncAppIngress(app.id);
  } catch (err) {
    log("migrate", `Ingress sync during drain failed (continuing): ${err}`);
  }

  emit("migrate", `Waiting 10s drain for ${replica.container_name}...`);
  await Bun.sleep(10_000);

  // Graceful stop first so SQLite WAL and other buffered writers flush.
  // `docker stop -t 20` sends SIGTERM, waits up to 20s, then SIGKILL.
  await sshExec(sourceServer.ipv4, asUser(`docker stop -t 20 ${replica.container_name} 2>/dev/null || true`), hostKey);
  await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);

  if (app.auth_password) {
    try {
      await removeAuthProxy(sourceServer.ipv4, replica.container_name, hostKey);
    } catch (err) {
      log("migrate", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
    }
  }

  db.deleteReplica(replica.id);
  emit("migrate", `Old replica ${replica.container_name} removed`);

  await syncAppIngress(app.id);

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
  rollbackCtx?: VolumeMigrationContext,
): Promise<MigrateResult> {
  if (sourceServer.location !== targetServer.location) {
    throw new Error(
      `Cannot migrate: volume lives in ${sourceServer.location}, target server is in ${targetServer.location}. Hetzner volumes are bound to a single location.`,
    );
  }

  const compute = hetzner;
  if (!compute.volumes) throw new Error("Compute provider does not support volumes");
  const volumeOps = compute.volumes;

  const sourceHostKey = sourceServer.ssh_host_key || undefined;
  const targetHostKey = targetServer.ssh_host_key || undefined;
  const currentCount = allReplicas.length;
  const volumeId = app.volume_id;

  // Probe current volume location up front — this drives both the Phase B
  // skip logic AND whether `app.volume_mount` can be trusted as the original.
  // On a retry where the volume is already on target, app.volume_mount has
  // likely already been rewritten to the canonical post-migration form, so we
  // can't safely restore it on rollback.
  const volumeInfoAtStart = await volumeOps.get(volumeId);
  const volumeAlreadyOnTarget = volumeInfoAtStart.serverId === targetServer.provider_id;

  if (rollbackCtx) {
    rollbackCtx.withVolume = true;
    rollbackCtx.app = app;
    rollbackCtx.replica = replica;
    rollbackCtx.sourceServer = sourceServer;
    rollbackCtx.targetServer = targetServer;
    // Always preserve the mount string. Even on retries where app.volume_mount
    // may already be in canonical post-migration form, in practice the pre/post
    // strings are identical for normally-deployed apps, and a missing -v flag
    // would silently strand the container on an anonymous Docker volume —
    // strictly worse than restoring a slightly-stale mount path.
    rollbackCtx.originalVolumeMount = app.volume_mount;
  }

  // Phase A — Stop source container. Probe for the container; if already gone,
  // skip the stop/rm but still mark destroyed (a prior attempt may have done it
  // and rollback needs to know).
  emit("migrate", `Stopping ${replica.container_name} on ${sourceServer.name}...`);
  db.updateReplicaStatus(replica.id, "draining");
  try {
    await syncAppIngress(app.id);
  } catch (err) {
    log("migrate", `Ingress sync during drain failed (continuing): ${err}`);
  }

  const probeCmd = asUser(`docker ps -a --filter name=^${replica.container_name}$ --format '{{.Names}}'`);
  const probe = await sshExec(sourceServer.ipv4, probeCmd, sourceHostKey);
  const containerPresent = probe.exitCode === 0 && probe.stdout.trim().length > 0;

  if (containerPresent) {
    // Graceful stop so SQLite WAL and other buffered writers flush before the
    // volume is detached. docker stop -t 20 gives the container a 20s grace window.
    await sshExec(sourceServer.ipv4, asUser(`docker stop -t 20 ${replica.container_name} 2>/dev/null || true`), sourceHostKey);
    await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), sourceHostKey);
  } else {
    log("migrate", `Source container ${replica.container_name} already gone — skipping stop/rm`);
  }
  if (rollbackCtx) rollbackCtx.sourceContainerDestroyed = true;

  if (app.auth_password) {
    try {
      await removeAuthProxy(sourceServer.ipv4, replica.container_name, sourceHostKey);
    } catch (err) {
      log("migrate", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
    }
  }

  // Phase B — Move volume from source to target. Branch on observed attachment.
  const onSource = volumeInfoAtStart.serverId === sourceServer.provider_id;
  const detached = volumeInfoAtStart.serverId === null;

  if (volumeAlreadyOnTarget) {
    log("migrate", `Volume ${volumeId} already on target ${targetServer.name} — skipping detach/attach`);
    if (rollbackCtx) {
      rollbackCtx.volumeDetachedFromSource = true;
      rollbackCtx.volumeAttachedToTarget = true;
    }
  } else if (onSource || detached) {
    if (onSource) {
      // Tear down the source bind mount (if any) before Hetzner pulls the
      // device — otherwise we leave a dangling bind on the source server.
      if (compute.id === "hetzner") {
        try {
          const { removeVolumeBindMount } = await import("../hetzner/host-mounts.ts");
          await removeVolumeBindMount({
            serverIp: sourceServer.ipv4,
            hostKey: sourceHostKey,
            hostMountPath: `/mnt/ocd-${app.name}-data`,
            blockName: `app-${app.id}`,
          });
        } catch (err) {
          log("migrate", `removeVolumeBindMount on source failed (continuing): ${err}`);
        }
      }
      emit("migrate", `Detaching volume from ${sourceServer.name}...`);
      await volumeOps.detach(volumeId);
      if (rollbackCtx) rollbackCtx.volumeDetachedFromSource = true;
    } else {
      // Mid-flight from a prior crash: already detached. Mark so rollback knows.
      if (rollbackCtx) rollbackCtx.volumeDetachedFromSource = true;
    }

    emit("migrate", `Attaching volume to ${targetServer.name}...`);
    try {
      await volumeOps.attach(volumeId, targetServer.provider_id);
      if (rollbackCtx) rollbackCtx.volumeAttachedToTarget = true;
    } catch (attachErr) {
      log("migrate", `Attach to target failed, attempting rollback to source: ${attachErr}`);
      try {
        await volumeOps.attach(volumeId, sourceServer.provider_id);
        if (rollbackCtx) rollbackCtx.volumeDetachedFromSource = false;
        log("migrate", `Volume rolled back to source ${sourceServer.name}`);
      } catch (rollbackErr) {
        log("migrate", `Rollback attach also failed — volume left detached: ${rollbackErr}`);
      }
      throw attachErr;
    }
  } else {
    throw new Error(
      `Volume ${volumeId} attached to unexpected server '${volumeInfoAtStart.serverId}' (expected source '${sourceServer.provider_id}' or target '${targetServer.provider_id}')`,
    );
  }

  // Phase C — Mount path + volume_mount DB row. Convention matches
  // handleReattachVolume in src/server/routes/volumes.ts.
  const hostMountPath = `/mnt/ocd-${app.name}-data`;
  if (compute.id === "hetzner") {
    const { ensureVolumeBindMount } = await import("../hetzner/host-mounts.ts");
    // Allow automount to settle after attach.
    await Bun.sleep(3000);
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await ensureVolumeBindMount({
          serverIp: targetServer.ipv4,
          hostKey: targetHostKey,
          hetznerVolumeId: volumeId,
          hostMountPath,
          blockName: `app-${app.id}`,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await Bun.sleep(3000);
      }
    }
    if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } else {
    await sshExec(targetServer.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, targetHostKey);
  }

  // Persist the canonical mount string so deploy/scale paths see the same value
  // they would after a fresh attach. Container path defaults to /data when missing.
  const containerPath = (app.volume_mount?.split(":")[1]) || "/data";
  const newVolumeMount = `${hostMountPath}:${containerPath}`;
  if (newVolumeMount !== app.volume_mount) {
    db.updateAppVolume(app.id, volumeId, newVolumeMount);
    app.volume_mount = newVolumeMount;
    if (rollbackCtx) rollbackCtx.volumeMountChanged = true;
  }

  // Phase D — Start new replica on target, unless a prior attempt already did.
  const replicasBeforeScale = db.getReplicas(app.id) as Replica[];
  const preExistingTarget = replicasBeforeScale.find(
    (r) => r.server_id === targetServer.id && r.id !== replica.id,
  );
  if (preExistingTarget) {
    log("migrate", `Found pre-existing target replica ${preExistingTarget.container_name} from prior attempt — skipping scaleUp`);
  } else {
    emit("migrate", `Starting ${app.name} on ${targetServer.name}...`);
    try {
      await scaleUp(app, allReplicas, currentCount, currentCount + 1, emit, targetServer.id);
    } catch (scaleErr) {
      log("migrate", `Failed to start replica on target after volume move: ${scaleErr}`);
      throw scaleErr;
    }
  }

  // Phase E — Drop old replica row if it's still around.
  const replicasAfterScale = db.getReplicas(app.id) as Replica[];
  if (replicasAfterScale.some((r) => r.id === replica.id)) {
    db.deleteReplica(replica.id);
  } else {
    log("migrate", `Old replica row ${replica.id} already gone — skipping deleteReplica`);
  }

  await syncAppIngress(app.id);

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

// Best-effort reversal of a partially-completed migrateWithVolume. Used by the
// saga's compensate hook. Must never throw — caller still wants to mark the op
// COMPENSATED even when full restoration isn't possible.
type CompensateLog = (line: string) => void;

export async function rollbackMigrateWithVolume(
  rb: VolumeMigrationContext,
  logLine: CompensateLog,
): Promise<void> {
  const { app, sourceServer, targetServer } = rb;
  if (!app || !sourceServer || !targetServer) {
    logLine(`MANUAL RECOVERY NEEDED: rollback ctx missing app/source/target`);
    return;
  }
  const sourceHostKey = sourceServer.ssh_host_key || undefined;

  // 1. Restore volume_mount in DB if we mutated it.
  if (rb.volumeMountChanged && rb.originalVolumeMount !== undefined) {
    try {
      db.updateAppVolume(app.id, app.volume_id, rb.originalVolumeMount);
      logLine(`Restored app.volume_mount to '${rb.originalVolumeMount}'`);
    } catch (err) {
      logLine(`MANUAL RECOVERY NEEDED: could not restore volume_mount: ${err}`);
    }
  }

  // 2. Move the volume back to source if it's on target.
  if (rb.volumeAttachedToTarget || rb.volumeDetachedFromSource) {
    try {
      const compute = hetzner;
      if (!compute.volumes) {
        logLine(`MANUAL RECOVERY NEEDED: provider has no volumes API — volume may be on ${targetServer.name}`);
      } else {
        if (rb.volumeAttachedToTarget) {
          try {
            await compute.volumes.detach(app.volume_id);
            logLine(`Detached volume from target ${targetServer.name}`);
          } catch (err) {
            logLine(`MANUAL RECOVERY NEEDED: failed to detach volume from target: ${err}`);
          }
        }
        try {
          await compute.volumes.attach(app.volume_id, sourceServer.provider_id);
          logLine(`Re-attached volume to source ${sourceServer.name}`);
        } catch (err) {
          logLine(`MANUAL RECOVERY NEEDED: failed to re-attach volume to source: ${err}`);
        }
      }
    } catch (err) {
      logLine(`MANUAL RECOVERY NEEDED: volume rollback threw: ${err}`);
    }
  }

  // 3. If we destroyed the source container, try to bring it back using the
  // existing local image. We don't trigger a rebuild here — that's a redeploy.
  if (rb.sourceContainerDestroyed) {
    try {
      const probe = `su - deploy -c ${JSON.stringify(`docker image inspect ${app.name}:latest >/dev/null 2>&1`)}`;
      const res = await sshExec(sourceServer.ipv4, probe, sourceHostKey);
      if (res.exitCode !== 0) {
        logLine(`MANUAL RECOVERY NEEDED: source container destroyed and image '${app.name}:latest' missing — redeploy required`);
      } else {
        try {
          await restartSourceReplica(rb, logLine);
        } catch (err) {
          logLine(`MANUAL RECOVERY NEEDED: failed to restart source container: ${err}`);
        }
      }
    } catch (err) {
      logLine(`MANUAL RECOVERY NEEDED: source container restore threw: ${err}`);
    }
  }
}

// Reconstruct a `docker run` for a non-compose replica that was destroyed on
// the source before rollback. We use the original volume mount because by the
// time this runs the volume has been re-attached to source. Throws on failure
// so the caller can surface MANUAL RECOVERY NEEDED.
async function restartSourceReplica(
  rb: VolumeMigrationContext,
  logLine: CompensateLog,
): Promise<void> {
  const { app, replica, sourceServer } = rb;
  if (!app || !replica || !sourceServer) {
    throw new Error("missing app/replica/sourceServer in rollback ctx");
  }
  const sourceHostKey = sourceServer.ssh_host_key || undefined;

  // Make sure the shared network exists before we reference it.
  await ensureOcdNetwork(sourceServer.ipv4, sourceHostKey);

  const bindAddr = replicaBindHost(sourceServer);
  const containerName = replica.container_name;
  const hostPort = replica.host_port;

  let extraVols: string[] = [];
  if (app.extra_volumes) {
    try {
      const parsed = JSON.parse(app.extra_volumes);
      if (Array.isArray(parsed)) extraVols = parsed.filter((v) => typeof v === "string");
    } catch { /* ignore malformed */ }
  }

  const envFilePathOnHost = `/home/deploy/apps/${app.name}/.env.deploy`;
  const probe = await sshExec(sourceServer.ipv4, asUser(`test -f ${envFilePathOnHost}`), sourceHostKey);
  const envFilePath = probe.exitCode === 0 ? envFilePathOnHost : undefined;

  // Best-effort: remove any stale container of the same name first.
  await sshExec(sourceServer.ipv4, asUser(`docker rm -f ${containerName} 2>/dev/null || true`), sourceHostKey);

  const cmd = buildDockerRunArgs({
    name: containerName,
    image: `${app.name}:latest`,
    appName: app.name,
    publish: { bindAddr, hostPort, containerPort: app.container_port },
    envFilePath,
    volumeMount: rb.originalVolumeMount || undefined,
    extraVolumes: extraVols,
    memoryMb: app.memory_mb || undefined,
  });
  const result = await sshExec(sourceServer.ipv4, asUser(cmd), sourceHostKey);
  if (result.exitCode !== 0) {
    throw new Error(`docker run exit ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  logLine(`Restarted source container ${containerName} on ${sourceServer.name}`);
}
