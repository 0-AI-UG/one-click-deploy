import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import { assertCleanupComplete, softStep, runDbCleanupGate } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { infrastructureProviderForServer, isManagedServer } from "../../shared/infrastructure.ts";

type DestroyServerInput = { serverId: number };

const preflight: Step<DestroyServerInput, { ok: true }> = {
  name: "preflight",
  label: "Preflight",
  async run(ctx) {
    if (db.getPanel()?.server_id === ctx.input.serverId) {
      throw new Error("Cannot destroy the panel's server");
    }
    const server = db.getServer(ctx.input.serverId);
    if (!server) throw new Error("Server not found");
    const localVolumePrefix = `local:${server.id}:`;
    const localApp = db.getApps(server.id).find((app) =>
      app.volume_driver === "local-directory" && !!app.volume_id
    );
    const retainedLocal = db.getRetiredVolumes().find((volume) =>
      volume.driver_id === "local-directory" && volume.provider_volume_id.startsWith(localVolumePrefix)
    );
    if (localApp || retainedLocal) {
      throw new Error(
        `Cannot disconnect ${server.name} while server-local volumes are tracked; remove their apps and permanently delete retained volumes first`,
      );
    }
    if (db.getBuildWorkerByServerId(ctx.input.serverId)) {
      throw new Error("Remove the OCD build worker before deleting its server");
    }
    return { ok: true };
  },
};

const destroyAppsOnServer: Step<DestroyServerInput, { appIds: number[]; failed: boolean }> = {
  name: "destroy_apps_on_server",
  label: "Destroy apps on server",
  async run(ctx) {
    const apps = db.getApps(ctx.input.serverId);
    const existing = new Map(
      listChildOperations(ctx.opId).map((child) => [child.idempotency_key ?? "", child]),
    );
    const childIds: number[] = [];
    for (const app of apps) {
      const idempotencyKey = `destroy_server:${ctx.opId}:app:${app.id}`;
      const prior = existing.get(idempotencyKey);
      const child = prior ?? enqueueOperation({
        kind: "destroy_app",
        resourceKeys: [
          `app:${app.id}`,
          ...(app.volume_id ? [`volume:${app.volume_id}`] : []),
        ],
        input: { appId: app.id },
        trigger: "cascade",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey,
      });
      childIds.push(child.id);
    }
    const result = await softStep(ctx, "destroy app children", async () => {
      await awaitChildren(ctx, { childIds });
    });
    return { appIds: apps.map((app) => app.id), failed: !result.ok };
  },
};

// Preflight rejects the panel server, so panel-resource cleanup here was dead
// code. More importantly, this boundary must run before provider deletion: a
// failed child destroy means the server still owns live resources.
const assertChildCleanup: Step<DestroyServerInput, { ok: true }> = {
  name: "assert_child_cleanup",
  label: "Verify child cleanup completed",
  async run(ctx, prior) {
    const childSteps = ["destroy_apps_on_server"];
    const failedSteps = runDbCleanupGate(prior).filter((name) => childSteps.includes(name));
    if (failedSteps.length > 0) {
      try { db.updateServerStatus(ctx.input.serverId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Child cleanup failed (${failedSteps.join(", ")}) — server retained and marked cleanup_failed`);
      assertCleanupComplete(prior, childSteps);
    }
    return { ok: true };
  },
};

const deleteCloudServer: Step<DestroyServerInput, { ok: boolean; error?: string }> = {
  name: "delete_cloud_server",
  label: "Delete cloud server",
  async run(ctx) {
    const server = db.getServer(ctx.input.serverId);
    if (!server || !isManagedServer(server) || !server.provider_id) {
      if (server?.ownership === "connected") ctx.log(`Disconnecting externally owned server ${server.name}; provider resources are untouched`);
      return { ok: true };
    }
    const r = await softStep(ctx, "delete_cloud_server", async () => {
      const compute = infrastructureProviderForServer(server);
      await compute.deleteServer(server.provider_id);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDbRows: Step<DestroyServerInput, { ok: boolean; failed: boolean; failedSteps: string[] }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try {
        db.updateServerStatus(ctx.input.serverId, "cleanup_failed");
      } catch { /* ignore */ }
      ctx.log(`Some child resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — server marked cleanup_failed`);
      return { ok: false, failed: true, failedSteps };
    }
    const result = await softStep(ctx, "delete_server_row", async () => {
      db.deleteServer(ctx.input.serverId);
    });
    if (!result.ok) {
      try { db.updateServerStatus(ctx.input.serverId, "cleanup_failed"); } catch { /* ignore */ }
      return { ok: false, failed: true, failedSteps: [`server:${ctx.input.serverId}`] };
    }
    return { ok: true, failed: false, failedSteps: [] };
  },
};

const assertDbCleanup: Step<DestroyServerInput, { ok: true }> = {
  name: "assert_db_cleanup",
  label: "Verify database cleanup completed",
  async run(_ctx, prior) {
    assertCleanupComplete(prior, ["delete_db_rows"]);
    return { ok: true };
  },
};

const destroyServerOp: OpKindDefinition<DestroyServerInput> = {
  kind: "destroy_server",
  label: "Destroy server",
  resourceKeys: (input) => {
    const keys: string[] = [`server:${input.serverId}`];
    try {
      for (const app of db.getApps(input.serverId)) keys.push(`app:${app.id}`);
    } catch {
      /* best-effort at enqueue time */
    }
    return keys;
  },
  steps: [
    preflight,
    destroyAppsOnServer,
    assertChildCleanup,
    deleteCloudServer,
    deleteDbRows,
    assertDbCleanup,
  ],
};

registerOp(destroyServerOp as OpKindDefinition<any>);

export default destroyServerOp;
export type { DestroyServerInput };
