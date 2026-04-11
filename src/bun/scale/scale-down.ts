import * as db from "../db.ts";
import {
  sshExec, deployCaddyWakePage,
  removeAuthProxy, stopContainer, stopCompose,
} from "../remote/index.ts";
import { syncAppCaddy, removeAppCaddy } from "./caddy-manager.ts";
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

      // Drop the replica from the Caddy upstream list first so in-flight
      // requests drain through the remaining healthy replicas instead of
      // the one we're about to stop.
      db.updateReplicaStatus(replica.id, "draining");
      try {
        await syncAppCaddy(app.id);
      } catch (err) {
        log("scale", `Caddy sync during drain failed (continuing): ${err}`);
      }
      emit("scale", `Waiting 10s drain for ${replica.container_name}...`);
      await Bun.sleep(10_000);

      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      if (preserveAsAnchor) {
        // Stop-but-preserve path (light sleep). Keep the container, env file,
        // and volume mount on disk so wake is `docker start`.
        if (app.deploy_mode === "compose") {
          try {
            await stopCompose(server.ipv4, app.name, hostKey);
          } catch (err) {
            log("scale", `Failed to stop compose project ${app.name}: ${err}`);
            throw err;
          }
        } else {
          try {
            await stopContainer(server.ipv4, replica.container_name, hostKey);
          } catch (err) {
            log("scale", `Failed to stop container ${replica.container_name}: ${err}`);
            throw err;
          }
        }
        // Leave auth proxy in place (if any) — it will proxy to the stopped
        // container during sleep, but nothing routes traffic there: Caddy is
        // pointing at the wake page. On wake, `docker start` restores the
        // backend without needing to re-deploy the auth proxy.
        db.markReplicaStopped(replica.id);
        emit("scale", `Replica ${replica.container_name} stopped (anchor for sleep)`);
      } else {
        // Stop-and-remove path (actual scale-down, not sleep).
        if (app.deploy_mode === "compose" && replica.container_name === app.name) {
          // This is the primary compose instance — handled separately during 2→1
        } else {
          await sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
        }

        if (app.auth_password) {
          try {
            await removeAuthProxy(server.ipv4, replica.container_name, hostKey);
          } catch (err) {
            log("scale", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
          }
        }

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

  // If going to 0, deploy wake page so HTTP requests auto-wake the app.
  if (targetCount === 0) {
    const lastRemoved = toRemove[toRemove.length - 1];
    const lastServer = db.getServer(lastRemoved.server_id);
    if (lastServer) {
      const wakeToken = crypto.randomUUID();
      db.updateAppSleepingState(app.id, lastServer.id, lastRemoved.host_port, wakeToken);
      const panel = db.getPanel();
      const panelDomain = panel?.domain || "";
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      // Remove the app's vhost from the panel's Caddy so the wake page
      // becomes the authoritative handler for this domain. The wake page
      // itself still lives on the tenant server for now — Phase 5 may
      // move it to the panel later.
      try {
        await removeAppCaddy(app.name, app.domain);
      } catch (err) {
        log("scale", `Failed to remove panel Caddy route during sleep: ${err}`);
      }
      await deployCaddyWakePage(
        lastServer.ipv4, app.domain, panelDomain, app.id, wakeToken, useInternalTls,
        lastServer.ssh_host_key || undefined
      );
    }
    db.updateAppStatus(app.id, "sleeping");
    emit("scale", "App scaled to zero — sleeping");
  } else {
    // Rewrite the Caddy vhost so the upstream list matches what's left
    // after the scale-down. The draining-phase sync above already removed
    // the draining replicas; this second sync is belt-and-braces.
    try {
      await syncAppCaddy(app.id);
    } catch (err) {
      log("scale", `Caddy sync after scale-down failed: ${err}`);
    }
  }

  // Decide what happens to every affected server uniformly. `freezeServerIfEmpty`
  // handles all three cases: still-in-use → no-op, completely empty → gc,
  // light-sleep anchor present → enqueue a freeze job.
  const candidateServerIds = new Set<number>();
  for (const replica of toRemove) {
    candidateServerIds.add(replica.server_id);
  }
  for (const serverId of candidateServerIds) {
    try {
      const before = db.getServer(serverId);
      await db.freezeServerIfEmpty(serverId);
      const after = db.getServer(serverId);
      if (before && !after) emit("scale", `Server ${before.name} deleted`);
      else if (after && db.getActiveFreezeJobForServer(serverId)) {
        emit("scale", `Server ${after.name} queued for freeze`);
      }
    } catch (err) {
      log("scale", `Failed to freeze/gc server ${serverId}: ${err}`);
    }
  }
}
