import * as db from "../../shared/db.ts";
import { log, type ProgressFn } from "./types.ts";
import { scaleUp, rollbackScaleUp } from "./scale-up.ts";
import { scaleDown } from "./scale-down.ts";
import { tryAcquire, release } from "../scheduler.ts";

// Statuses in which an app's replica count is eligible for convergence.
// Everything else — sleeping/waking (which keep a stopped anchor replica),
// paused, deploying, error — is owned by its own state machine and must be
// left untouched here.
const CONVERGEABLE = new Set(["running", "unhealthy"]);

// Sentinel op id for the reconciler's hold on `app:<id>`. Negative so it can
// never collide with a real operations-table row id.
const RECONCILER_OP_ID = -1;

/**
 * Level-triggered replica convergence — the ReplicaSet-controller half of the
 * kubernetes decide-vs-act split. This is the ONLY place that adds or removes
 * replicas outside the deploy saga: the autoscaler and the manual scaling API
 * merely write `apps.desired_replicas` and let this loop make reality match.
 *
 * It records no scaling_event and rewrites neither desired_replicas nor
 * last_scale_at — the intent, and its trigger label, was already recorded by
 * whoever set desired_replicas. This function only performs the physical work.
 *
 * Reaching desired == 0 flows through scaleDown(…, 0), which stops containers,
 * keeps the sleeping anchor, installs the wake page and flips the app to
 * `sleeping` — so scale-to-zero is just the count-0 case, not a special path.
 */
export async function convergeAppReplicas(appId: number): Promise<void> {
  const app = db.getApp(appId);
  if (!app || !CONVERGEABLE.has(app.status)) return;

  // A cloud volume attaches to exactly one server, so volume apps are hard
  // capped at a single replica regardless of what desired_replicas holds.
  const effectiveMax = app.volume_id ? 1 : Infinity;
  const desired = Math.max(0, Math.min(app.desired_replicas, effectiveMax));

  const currentReplicas = db.getReplicas(appId);
  const currentCount = currentReplicas.length;
  if (currentCount === desired) return;
  // A running app with zero replica rows is a job for health/recreate or a
  // fresh deploy, not for scale convergence.
  if (currentCount === 0) return;

  // Serialize against saga ops (deploy child, migrate, redeploy, rollback)
  // mutating the same app. Non-blocking: if a real op holds the app lock we
  // skip this tick — the next tick re-derives the gap and tries again.
  const lock = tryAcquire([`app:${appId}`], RECONCILER_OP_ID, "reconcile:scale");
  if (!lock.ok) {
    log("converge", `app ${appId}: app:${appId} held by ${lock.heldBy.kind}#${lock.heldBy.opId} — skip`);
    return;
  }
  try {
    const emit: ProgressFn = (step, detail) => log("converge", `app ${appId} [${step}] ${detail}`);
    if (desired > currentCount) {
      try {
        await scaleUp(app, currentReplicas, currentCount, desired, emit);
      } catch (err) {
        emit("scale", `scale-up failed, rolling back: ${err}`);
        await rollbackScaleUp(app, currentReplicas, emit);
        throw err;
      }
    } else {
      await scaleDown(app, currentReplicas, currentCount, desired, emit);
    }
    log("converge", `app ${appId}: converged ${currentCount} -> ${desired}`);
  } catch (err) {
    log("converge", `app ${appId}: convergence failed: ${err}`);
  } finally {
    release([`app:${appId}`]);
  }
}
