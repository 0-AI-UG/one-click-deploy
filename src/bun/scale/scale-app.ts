import * as db from "../db.ts";
import { type ProgressFn, log } from "./types.ts";
import { scaleUp, rollbackScaleUp } from "./scale-up.ts";
import { scaleDown } from "./scale-down.ts";

export async function scaleApp(
  appId: number,
  targetReplicas: number,
  onProgress?: ProgressFn,
  targetServerId?: number
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});
  log("scale", `Scaling app ${appId} to ${targetReplicas} replicas`);

  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const currentReplicas = db.getReplicas(appId);
    const currentCount = currentReplicas.length;

    if (targetReplicas === currentCount) {
      return { ok: true };
    }

    if (targetReplicas < 0) {
      return { ok: false, error: "Replicas cannot be negative" };
    }

    if (targetReplicas > currentCount) {
      try {
        await scaleUp(app, currentReplicas, currentCount, targetReplicas, emit, targetServerId);
      } catch (err) {
        // Rollback: clean up any resources created during failed scale-up
        emit("scale", "Scale-up failed, rolling back...");
        await rollbackScaleUp(app, currentReplicas, emit);
        throw err;
      }
    } else {
      await scaleDown(app, currentReplicas, currentCount, targetReplicas, emit);
    }

    db.updateAppScaling(appId, {
      desired_replicas: targetReplicas,
      last_scale_at: new Date().toISOString(),
    });

    db.insertScalingEvent({
      app_id: appId,
      event_type: targetReplicas > currentCount ? "scale_up" : "scale_down",
      from_count: currentCount,
      to_count: targetReplicas,
      reason: "manual",
    });

    log("scale", `App ${appId} scaled from ${currentCount} to ${targetReplicas}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("scale", `Failed to scale app ${appId}: ${msg}`);
    return { ok: false, error: msg };
  }
}
