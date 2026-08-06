import * as db from "../shared/db.ts";
import { enqueueOperation, findActiveOperationByResourceKey } from "../shared/db/operations.ts";
import { resolveAppEnvVars } from "../shared/env-crypto.ts";
import { attestReplica, hashEnvironment } from "./revision.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [app-runtime-reconciler]`, ...args);
}

/** Reconcile explicitly requested rollout generations and periodically attest
 * live replicas. Repairs reuse reload_app, which applies the recorded immutable
 * image and current environment without rebuilding source. */
export async function reconcileAppRuntime(): Promise<void> {
  for (const snapshot of db.getApps()) {
    const key = `app:${snapshot.id}`;
    const lock = tryAcquire([key], NON_OP_HOLDER, "reconcile:app-runtime");
    if (!lock.ok) continue;
    try {
      const app = db.getApp(snapshot.id);
      if (!app) continue;
      if (app.deletion_requested_at) {
        if (!findActiveOperationByResourceKey("destroy_app", key)) {
          const volumeKeys = app.volume_id ? [`volume:${app.volume_id}`] : [];
          enqueueOperation({
            kind: "destroy_app",
            resourceKeys: [key, ...volumeKeys],
            input: { appId: app.id },
            trigger: "reconciler",
            triggeredBy: "system:app-finalizer",
          });
          log(`${app.name}: queued deletion finalizer retry`);
        }
        continue;
      }
      if (!["running", "unhealthy"].includes(app.status)) continue;
      const deployed = db.getDeployments(app.id).find((row) => row.status === "deployed");

      if (
        app.rollout_requested_revision > 0 &&
        deployed &&
        deployed.id > app.rollout_requested_after_deployment_id &&
        deployed.config_revision >= app.rollout_requested_revision
      ) {
        db.clearAppRolloutRequest(app.id, deployed.config_revision);
        continue;
      }

      if (
        app.rollout_requested_revision > 0 &&
        (
          !deployed ||
          deployed.id <= app.rollout_requested_after_deployment_id ||
          deployed.config_revision < app.rollout_requested_revision
        )
      ) {
        if (!findActiveOperationByResourceKey("redeploy", key)) {
          enqueueOperation({
            kind: "redeploy",
            resourceKeys: [key],
            input: { appId: app.id, userId: app.deployed_by || undefined },
            trigger: "reconciler",
            triggeredBy: "system:app-runtime-reconciler",
          });
          log(`${app.name}: queued requested rollout r${app.rollout_requested_revision}`);
        }
        continue;
      }
      if (!deployed?.image_digest || deployed.config_revision !== app.config_revision) continue;

      const envHash = hashEnvironment(await resolveAppEnvVars(app));
      if (deployed.env_hash && deployed.env_hash !== envHash) continue;
      const expected = {
        imageDigest: deployed.image_digest,
        envHash,
        configRevision: deployed.config_revision,
      };
      let persistentDivergence = false;
      for (const replica of db.getReplicas(app.id)) {
        const server = db.getServer(replica.server_id);
        if (!server || server.status !== "ready") continue;
        const wasDivergent = replica.status === "divergent" && !!replica.attestation_error;
        const attestation = await attestReplica(app, replica, server, expected);
        if (!attestation.ok && wasDivergent) persistentDivergence = true;
      }
      if (persistentDivergence && !findActiveOperationByResourceKey("reload_app", key)) {
        enqueueOperation({
          kind: "reload_app",
          resourceKeys: [key],
          input: { appId: app.id, force: true },
          trigger: "reconciler",
          triggeredBy: "system:app-runtime-reconciler",
        });
        log(`${app.name}: queued immutable runtime repair`);
      }
    } catch (error) {
      log(`${snapshot.name}: ${error}`);
    } finally {
      release([key]);
    }
  }
}
