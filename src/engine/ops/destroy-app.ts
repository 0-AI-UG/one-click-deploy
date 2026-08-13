import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import * as github from "../../shared/github.ts";
import {
  sshExec,
  removeContainer,
} from "../../shared/remote/index.ts";
import { awaitChildren } from "./_children.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { reconcileAppDns } from "../dns-reconciler.ts";
import { registerOp } from "./registry.ts";
import { assertCleanupComplete, softStep, runDbCleanupGate, makeGcEmptyServersStep } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyInput = {
  appId: number;
  /** Failed-deploy cleanup may expire automatically after the recovery window. */
  retentionClass?: "user" | "provisional";
};

const markDeleting: Step<DestroyInput, { ok: true }> = {
  name: "mark_deleting",
  label: "Mark deletion intent",
  async run(ctx) {
    if (db.getApp(ctx.input.appId)) db.markAppDeletionRequested(ctx.input.appId);
    return { ok: true };
  },
};

/**
 * Tear down the app's hidden `<name>-staging` sibling first, as a child
 * `destroy_app`.
 *
 * A webhook-staging sibling deliberately carries no `stack_id` and is filtered
 * out of every app listing, so nothing else would ever reach it: destroying the
 * production app (directly, or via `destroy_stack`, which fans out to this very
 * op) used to leave the sibling running and invisible, still holding its
 * containers, internal port/VIP and volume. Delegating to a child op reuses the
 * whole teardown path rather than duplicating it.
 *
 * Recursion is impossible: a sibling has `target_of != null`, and this step
 * only looks for a sibling when `target_of` is null.
 */
const destroyStagingSibling: Step<DestroyInput, { ok: boolean; childIds: number[]; error?: string }> = {
  name: "destroy_staging_sibling",
  label: "Destroy staging sibling",
  async run(ctx) {
    // Adopt a child from a previous attempt BEFORE looking at the sibling row.
    // That child's whole job is to delete the row, so by the time we resume it
    // may already be gone — and resolving the sibling first would then read as
    // "nothing to cascade to", abandoning a destroy that is still in flight and
    // letting us dismantle production underneath it. The key is therefore keyed
    // on this step, not on the sibling id, so it stays findable afterwards.
    const idk = `destroy_app:${ctx.opId}:staging-sibling`;
    const prev = listChildOperations(ctx.opId).find((c) => c.idempotency_key === idk);

    let childId: number;
    if (prev) {
      childId = prev.id;
    } else {
      const app = db.getApp(ctx.input.appId);
      // Already gone, or this IS a staging/dev target — nothing to cascade to.
      // The `target_of` guard is what makes recursion impossible: a sibling is
      // never asked for a sibling of its own.
      if (!app || app.target_of != null) return { ok: true, childIds: [] };
      const sibling = db.getStagingSibling(app.id);
      if (!sibling) return { ok: true, childIds: [] };

      childId = enqueueOperation({
        kind: "destroy_app",
        resourceKeys: [
          `app:${sibling.id}`,
          ...(sibling.volume_id ? [`volume:${sibling.volume_id}`] : []),
        ],
        input: {
          appId: sibling.id,
          ...(ctx.input.retentionClass ? { retentionClass: ctx.input.retentionClass } : {}),
        },
        trigger: "cascade",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      }).id;
      ctx.log(`destroying staging sibling ${sibling.name} (app #${sibling.id})`);
    }
    // Best-effort like every other destroy step: a failed sibling teardown is
    // reported through the db-cleanup gate (leaving the app `cleanup_failed`
    // for the reconciler) instead of throwing out of the parent destroy.
    const r = await softStep(ctx, "destroy_staging_sibling", async () => {
      await awaitChildren(ctx, { childIds: [childId] });
    });
    return r.ok
      ? { ok: true, childIds: [childId] }
      : { ok: false, childIds: [childId], error: r.error };
  },
};

const removeGithubWebhook: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_github_webhook",
  label: "Remove GitHub webhook",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { ok: true };
    if (!app.github_webhook_id) return { ok: true };
    const r = await softStep(ctx, "remove_github_webhook", async () => {
      const pat = await github.getGitHubPat(app.deployed_by || undefined);
      if (!pat) throw new Error("GitHub token unavailable; refusing to orphan the configured webhook");
      await github.deleteWebhook({
        gitRepo: app.github_webhook_repo || app.git_repo,
        webhookId: app.github_webhook_id,
        token: pat,
      });
    });
    if (r.ok) {
      db.updateAppWebhook(
        app.id, false, "", app.webhook_branch, "", app.webhook_path,
        !!app.webhook_wait_for_ci, !!app.webhook_staging,
      );
    }
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const stopAndRemoveContainers: Step<DestroyInput, { affectedServerIds: number[]; failed: boolean }> = {
  name: "stop_and_remove_containers",
  label: "Stop and remove containers",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { affectedServerIds: [], failed: false };
    const replicas = db.getReplicas(ctx.input.appId);
    const affected = new Set<number>();
    let failed = false;
    for (const replica of replicas) {
      affected.add(replica.server_id);
      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      const r = await softStep(ctx, `rm ${replica.container_name}`, async () => {
        await removeContainer(server.ipv4, replica.container_name, hostKey);
      });
      if (!r.ok) failed = true;
      await softStep(ctx, `rmdir ${app.name}`, async () => {
        await sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
      });
    }
    return { affectedServerIds: Array.from(affected), failed };
  },
};

// Runs AFTER delete_db_rows: ingress is a desired-state render of the DB, so
// the app's routers only disappear from the rendered config once its rows are
// gone. (If the row deletion was skipped because of upstream failures, this
// re-render is a harmless no-op and the reconciler converges later.)
const removeIngressRoute: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_ingress_route",
  label: "Remove ingress route",
  async run(ctx) {
    const r = await softStep(ctx, "remove_ingress_route", async () => {
      await syncAllTraefik();
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDnsRecords: Step<DestroyInput, { ok: boolean; failed: boolean }> = {
  name: "delete_dns_records",
  label: "Delete DNS records",
  async run(ctx) {
    const result = await softStep(ctx, "delete_dns_records", async () => {
      await reconcileAppDns(ctx.input.appId, { alreadyLocked: true });
    });
    return { ok: result.ok, failed: !result.ok };
  },
};

const deleteVolume: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "delete_volume",
  label: "Detach and retain volume",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app || !app.volume_id) return { ok: true };
    const r = await softStep(ctx, "delete_volume", async () => {
      const compute = hetzner;
      if (app.volume_attached) {
        // Pre-existing volume attached via attach_existing_volume — it predates
        // us and may hold data we don't own. DETACH only; never delete.
        await compute.volumes?.detach(app.volume_id);
      } else {
        await compute.volumes?.detach(app.volume_id);
        db.retireVolume({
          providerVolumeId: app.volume_id,
          formerResourceType: "app",
          formerResourceId: app.id,
          formerResourceName: app.name,
          reason: `app destroy operation #${ctx.opId}`,
          retentionClass: ctx.input.retentionClass ?? "user",
        });
        ctx.log(`Detached volume ${app.volume_id}; retained for recovery for 7 days`);
      }
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

type DeleteDbRowsOut = { ok: boolean; failed: boolean; failedSteps: string[] };

const deleteDbRows: Step<DestroyInput, DeleteDbRowsOut> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    // Gate: if ANY upstream destroy step partially failed, do not delete DB
    // rows. Mark the app `cleanup_failed` and surface to the reconciler.
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Some resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — app marked cleanup_failed`);
      return { ok: false, failed: true, failedSteps };
    }
    const replicas = db.getReplicas(ctx.input.appId);
    const dbFailures: string[] = [];
    for (const replica of replicas) {
      const result = await softStep(ctx, `delete_replica ${replica.id}`, async () => {
        db.deleteReplica(replica.id);
      });
      if (!result.ok) dbFailures.push(`replica:${replica.id}`);
    }
    // Preserve the app as the retry/recovery anchor when a child row could not
    // be removed. Deleting it may cascade the evidence needed for recovery.
    if (dbFailures.length === 0) {
      const result = await softStep(ctx, "delete_app", async () => {
        db.deleteApp(ctx.input.appId);
      });
      if (!result.ok) dbFailures.push(`app:${ctx.input.appId}`);
    }
    if (dbFailures.length > 0) {
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Database cleanup failed (${dbFailures.join(", ")}) — app marked cleanup_failed`);
      return { ok: false, failed: true, failedSteps: dbFailures };
    }
    return { ok: true, failed: false, failedSteps: [] };
  },
};

const assertDbCleanup: Step<DestroyInput, { ok: true }> = {
  name: "assert_db_cleanup",
  label: "Verify cleanup completed",
  async run(_ctx, prior) {
    assertCleanupComplete(prior, ["delete_db_rows"]);
    return { ok: true };
  },
};

const gcEmptyServers = makeGcEmptyServersStep<DestroyInput>("stop_and_remove_containers");

const destroyAppOp: OpKindDefinition<DestroyInput> = {
  kind: "destroy_app",
  label: "Destroy app",
  resourceKeys: (input) => {
    const volumeId = db.getApp(input.appId)?.volume_id;
    return [`app:${input.appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])];
  },
  steps: [
    markDeleting,
    destroyStagingSibling,
    removeGithubWebhook,
    stopAndRemoveContainers,
    deleteDnsRecords,
    deleteVolume,
    deleteDbRows,
    removeIngressRoute,
    gcEmptyServers,
    assertDbCleanup,
  ],
};

registerOp(destroyAppOp as OpKindDefinition<any>);

export default destroyAppOp;
export type { DestroyInput };
