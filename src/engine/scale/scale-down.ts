import * as db from "../../shared/db.ts";
import {
  sshExec,
  stopContainer,
} from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";

export async function scaleDown(
  app: App,
  currentReplicas: Replica[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn
) {
  // Sort: prefer unhealthy first, then newest
  const sorted = [...currentReplicas].sort((a, b) => {
    if (a.status !== "running" && b.status === "running") return -1;
    if (a.status === "running" && b.status !== "running") return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const toRemove = sorted.slice(0, currentCount - targetCount);

  // When scaling to zero, the *last* replica in `toRemove` is kept on disk as
  // the "sleeping anchor": container stopped (not removed), replica row
  // preserved with status = "stopped". This makes wake a single `docker start`
  // (~1s) instead of a fresh `docker run` (~several seconds). All other
  // replicas going away are genuinely removed.
  const goingToZero = targetCount === 0;
  const anchorIdx = goingToZero ? toRemove.length - 1 : -1;

  let removedCount = 0;
  for (let i = 0; i < toRemove.length; i++) {
    const replica = toRemove[i];
    const preserveAsAnchor = i === anchorIdx;
    try {
      emit("scale", `Draining replica ${replica.container_name}...`);

      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      // Drop the replica from the ingress upstream pool first so in-flight
      // requests drain through the remaining healthy replicas instead of
      // the one we're about to stop.
      db.updateReplicaStatus(replica.id, "draining");
      try {
        await syncAppIngress(app.id);
      } catch (err) {
        log("scale", `Ingress sync during drain failed (continuing): ${err}`);
      }
      emit("scale", `Waiting 10s drain for ${replica.container_name}...`);
      await Bun.sleep(10_000);

      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      if (preserveAsAnchor) {
        // Stop-but-preserve path (light sleep). Keep the container, env file,
        // and volume mount on disk so wake is `docker start`.
        try {
          await stopContainer(server.ipv4, replica.container_name, hostKey);
        } catch (err) {
          log("scale", `Failed to stop container ${replica.container_name}: ${err}`);
          throw err;
        }
        db.markReplicaStopped(replica.id);
        emit("scale", `Replica ${replica.container_name} stopped (anchor for sleep)`);
      } else {
        // Stop-and-remove path (actual scale-down, not sleep).
        await sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);

        db.deleteReplica(replica.id);
        emit("scale", `Replica ${replica.container_name} removed`);
      }
      removedCount++;
    } catch (err) {
      log("scale", `Failed to remove replica ${replica.container_name}: ${err}`);
      // Stop attempting further removals — don't make things worse
      break;
    }
  }

  if (removedCount < toRemove.length) {
    const actualCount = currentCount - removedCount;
    db.updateAppScaling(app.id, { desired_replicas: actualCount });
    throw new Error(`Scale-down incomplete — only removed ${removedCount} of ${toRemove.length} replicas. Some servers may need manual cleanup.`);
  }

  // If going to 0, record the sleeping state and re-render ingress: the
  // desired-state renderer routes the sleeping app's public domain to the
  // panel, which serves the 503 wake page so HTTP requests auto-wake the
  // app. Private apps (domain = '') get no wake route — they sleep without
  // one and wake via dashboard/CLI/API.
  if (targetCount === 0) {
    const lastRemoved = toRemove[toRemove.length - 1];
    const lastServer = db.getServer(lastRemoved.server_id);
    if (lastServer) {
      const wakeToken = crypto.randomUUID();
      db.updateAppSleepingState(app.id, lastServer.id, lastRemoved.host_port, wakeToken);
    }
    db.updateAppStatus(app.id, "sleeping");
    try {
      await syncAppIngress(app.id);
    } catch (err) {
      log("scale", `Ingress sync after sleep failed: ${err}`);
    }
    emit("scale", "App scaled to zero — sleeping");
  } else {
    // Re-render ingress so the upstream pool matches what's left after the
    // scale-down. The draining-phase sync above already removed the
    // draining replicas; this second sync is belt-and-braces.
    try {
      await syncAppIngress(app.id);
    } catch (err) {
      log("scale", `Ingress sync after scale-down failed: ${err}`);
    }
  }

  // GC any server whose last app just went away. `gcServerIfEmpty` no-ops if
  // the server still has replica rows — including stopped anchors — so
  // scale-to-zero leaves the tenant VM materialized and only the
  // last-app-on-a-server case actually destroys the instance.
  const candidateServerIds = new Set<number>();
  for (const replica of toRemove) {
    candidateServerIds.add(replica.server_id);
  }
  for (const serverId of candidateServerIds) {
    try {
      const before = db.getServer(serverId);
      await db.gcServerIfEmpty(serverId);
      const after = db.getServer(serverId);
      if (before && !after) emit("scale", `Server ${before.name} deleted`);
    } catch (err) {
      log("scale", `Failed to gc server ${serverId}: ${err}`);
    }
  }
}
