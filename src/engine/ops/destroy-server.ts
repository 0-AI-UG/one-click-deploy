import * as db from "../../shared/db.ts";
import { getComputeProvider, getDnsProvider } from "../../shared/providers/index.ts";
import { destroyApp } from "../deploy/lifecycle.ts";
import { destroyService } from "../deploy/service-lifecycle.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyServerInput = { serverId: number };

async function softStep<T>(
  ctx: { log: (s: string) => void },
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[${name}] failed (continuing): ${msg}`);
    return { ok: false, error: msg };
  }
}

const preflight: Step<DestroyServerInput, { ok: true }> = {
  name: "preflight",
  label: "Preflight",
  async run(ctx) {
    if (db.getPanel()?.server_id === ctx.input.serverId) {
      throw new Error("Cannot destroy the panel's server");
    }
    const server = db.getServerUnscoped(ctx.input.serverId);
    if (!server) throw new Error("Server not found");
    return { ok: true };
  },
};

const destroyAppsOnServer: Step<DestroyServerInput, { appIds: number[]; failed: boolean }> = {
  name: "destroy_apps_on_server",
  label: "Destroy apps on server",
  async run(ctx) {
    const apps = db.getApps(ctx.orgId, ctx.input.serverId);
    let failed = false;
    for (const app of apps) {
      const r = await softStep(ctx, `destroy_app ${app.name}`, async () => {
        const result = await destroyApp(app.id);
        if (!result.ok) throw new Error(result.error || "destroyApp returned ok=false");
      });
      if (!r.ok) failed = true;
    }
    return { appIds: apps.map((a) => a.id), failed };
  },
};

const destroyServicesOnServer: Step<DestroyServerInput, { serviceIds: number[]; failed: boolean }> = {
  name: "destroy_services_on_server",
  label: "Destroy services on server",
  async run(ctx) {
    const services = db.getServicesOnServer(ctx.input.serverId);
    let failed = false;
    for (const svc of services) {
      const r = await softStep(ctx, `destroy_service ${svc.name}`, async () => {
        const result = await destroyService(svc.id);
        if (!result.ok) throw new Error(result.error || "destroyService returned ok=false");
      });
      if (!r.ok) failed = true;
    }
    return { serviceIds: services.map((s) => s.id), failed };
  },
};

const cleanupPanelRow: Step<DestroyServerInput, { ok: true }> = {
  name: "cleanup_panel_row",
  label: "Cleanup panel row",
  async run(ctx) {
    const panel = db.getPanel();
    const server = db.getServerUnscoped(ctx.input.serverId);
    if (!panel || panel.server_id !== ctx.input.serverId || !server) return { ok: true };
    if (panel.dns_zone_id && panel.dns_name && panel.dns_type && panel.dns_value) {
      await softStep(ctx, "delete_panel_dns", async () => {
        const dns = getDnsProvider();
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
        const compute = getComputeProvider(server.provider);
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
    const server = db.getServerUnscoped(ctx.input.serverId);
    if (!server || !server.provider_id) return { ok: true };
    const r = await softStep(ctx, "delete_cloud_server", async () => {
      const compute = getComputeProvider(server.provider);
      await compute.deleteServer(server.provider_id);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteDbRows: Step<DestroyServerInput, { ok: true }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    const apps = prior["destroy_apps_on_server"] as { failed: boolean } | undefined;
    const svcs = prior["destroy_services_on_server"] as { failed: boolean } | undefined;
    const cloud = prior["delete_cloud_server"] as { ok: boolean } | undefined;
    const anyFailed = apps?.failed || svcs?.failed || (cloud && !cloud.ok);
    if (anyFailed) {
      try {
        db.updateServerStatus(ctx.input.serverId, "cleanup_failed");
      } catch { /* ignore */ }
      ctx.log("Some child resources could not be cleaned up — server marked cleanup_failed");
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
      const server = db.getServerUnscoped(input.serverId);
      const orgId = server?.org_id ?? "";
      for (const app of db.getApps(orgId, input.serverId)) keys.push(`app:${app.id}`);
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

registerOp(destroyServerOp);

export default destroyServerOp;
export type { DestroyServerInput };
