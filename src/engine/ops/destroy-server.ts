import * as db from "../../shared/db.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import { softStep, runDbCleanupGate } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

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

const destroyServicesOnServer: Step<DestroyServerInput, { serviceIds: number[]; failed: boolean }> = {
  name: "destroy_services_on_server",
  label: "Destroy services on server",
  async run(ctx) {
    const services = db.getServicesOnServer(ctx.input.serverId);
    const existing = new Map(
      listChildOperations(ctx.opId).map((child) => [child.idempotency_key ?? "", child]),
    );
    const childIds: number[] = [];
    for (const svc of services) {
      const idempotencyKey = `destroy_server:${ctx.opId}:service:${svc.id}`;
      const prior = existing.get(idempotencyKey);
      const volumeKeys = db.getServiceInstances(svc.id)
        .filter((instance) => !!instance.volume_id)
        .map((instance) => `volume:${instance.volume_id}`);
      const child = prior ?? enqueueOperation({
        kind: "destroy_service",
        resourceKeys: [`service:${svc.id}`, ...volumeKeys],
        input: { serviceId: svc.id },
        trigger: "cascade",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey,
      });
      childIds.push(child.id);
    }
    const result = await softStep(ctx, "destroy service children", async () => {
      await awaitChildren(ctx, { childIds });
    });
    return { serviceIds: services.map((service) => service.id), failed: !result.ok };
  },
};

const cleanupPanelRow: Step<DestroyServerInput, { ok: true }> = {
  name: "cleanup_panel_row",
  label: "Cleanup panel row",
  async run(ctx) {
    const panel = db.getPanel();
    const server = db.getServer(ctx.input.serverId);
    if (!panel || panel.server_id !== ctx.input.serverId || !server) return { ok: true };
    if (panel.dns_zone_id && panel.dns_name && panel.dns_type && panel.dns_value) {
      await softStep(ctx, "delete_panel_dns", async () => {
        const dns = hetznerDns;
        await dns.deleteRecord({
          zoneId: panel.dns_zone_id,
          name: panel.dns_name,
          type: panel.dns_type,
          value: panel.dns_value,
        });
      });
    }
    if (panel.volume_id) {
      await softStep(ctx, "delete_panel_volume", async () => {
        const compute = hetzner;
        await compute.volumes?.delete(panel.volume_id);
      });
    }
    await softStep(ctx, "delete_panel_row", async () => {
      db.deletePanel();
    });
    return { ok: true };
  },
};

const deleteCloudServer: Step<DestroyServerInput, { ok: boolean; error?: string }> = {
  name: "delete_cloud_server",
  label: "Delete cloud server",
  async run(ctx) {
    const server = db.getServer(ctx.input.serverId);
    if (!server || !server.provider_id) return { ok: true };
    const r = await softStep(ctx, "delete_cloud_server", async () => {
      const compute = hetzner;
      await compute.deleteServer(server.provider_id);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDbRows: Step<DestroyServerInput, { ok: true }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try {
        db.updateServerStatus(ctx.input.serverId, "cleanup_failed");
      } catch { /* ignore */ }
      ctx.log(`Some child resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — server marked cleanup_failed`);
      return { ok: true };
    }
    await softStep(ctx, "delete_server_row", async () => {
      db.deleteServer(ctx.input.serverId);
    });
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
      for (const svc of db.getServicesOnServer(input.serverId)) keys.push(`service:${svc.id}`);
    } catch {
      /* best-effort at enqueue time */
    }
    return keys;
  },
  steps: [
    preflight,
    destroyAppsOnServer,
    destroyServicesOnServer,
    cleanupPanelRow,
    deleteCloudServer,
    deleteDbRows,
  ],
};

registerOp(destroyServerOp as OpKindDefinition<any>);

export default destroyServerOp;
export type { DestroyServerInput };
