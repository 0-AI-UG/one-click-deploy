import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyServiceInput = { serviceId: number };

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

const removeEnvFromLinkedApps: Step<DestroyServiceInput, { ok: true }> = {
  name: "remove_env_vars_from_linked_apps",
  label: "Remove env vars from linked apps",
  async run(ctx) {
    const links = db.getServiceLinks(ctx.input.serviceId);
    for (const link of links) {
      await softStep(ctx, `unlink_env app#${link.app_id}`, async () => {
        const app = db.getAppUnscoped(link.app_id);
        if (!app?.environment_id) return;
        const envRow = db.getEnvironmentUnscoped(app.environment_id);
        if (!envRow) return;
        const parsed = parseEnvVars(envRow.env_vars);
        const prefix = link.env_prefix || "DATABASE";
        const filtered = parsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
        db.updateEnvironment(app.environment_id, envRow.name, serializeEnvVars(filtered));
      });
    }
    return { ok: true };
  },
};

const stopAndRemoveContainers: Step<DestroyServiceInput, { affectedServerIds: number[]; failed: boolean }> = {
  name: "stop_and_remove_instance_container",
  label: "Stop and remove containers",
  async run(ctx) {
    const service = db.getServiceUnscoped(ctx.input.serviceId);
    const instances = db.getServiceInstances(ctx.input.serviceId);
    const affected = new Set<number>();
    let failed = false;
    for (const inst of instances) {
      affected.add(inst.server_id);
      const server = db.getServerUnscoped(inst.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      const r = await softStep(ctx, `rm ${inst.container_name}`, async () => {
        await sshExec(
          server.ipv4,
          `su - deploy -c "docker rm -f ${inst.container_name} 2>/dev/null || true"`,
          hostKey,
        );
      });
      if (!r.ok) failed = true;
      if (service) {
        await softStep(ctx, `rmdir service ${service.name}`, async () => {
          await sshExec(server.ipv4, `rm -rf /home/deploy/services/${service.name}`, hostKey);
        });
      }
    }
    return { affectedServerIds: Array.from(affected), failed };
  },
};

const deleteVolumes: Step<DestroyServiceInput, { failed: boolean }> = {
  name: "delete_volume",
  label: "Delete volume",
  async run(ctx) {
    const instances = db.getServiceInstances(ctx.input.serviceId);
    let failed = false;
    for (const inst of instances) {
      if (!inst.volume_id) continue;
      const server = inst.server_id ? db.getServerUnscoped(inst.server_id) : null;
      const r = await softStep(ctx, `delete_volume ${inst.volume_id}`, async () => {
        const compute = getComputeProvider(server?.provider);
        await compute.volumes?.delete(inst.volume_id);
      });
      if (!r.ok) failed = true;
    }
    return { failed };
  },
};

const deleteDbRows: Step<DestroyServiceInput, { ok: true }> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    const containers = prior["stop_and_remove_instance_container"] as { failed: boolean } | undefined;
    const vol = prior["delete_volume"] as { failed: boolean } | undefined;
    const anyFailed = containers?.failed || vol?.failed;
    if (anyFailed) {
      try { db.updateServiceStatus(ctx.input.serviceId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log("Some resources could not be cleaned up — service marked cleanup_failed");
      return { ok: true };
    }
    const instances = db.getServiceInstances(ctx.input.serviceId);
    for (const inst of instances) {
      await softStep(ctx, `delete_instance ${inst.id}`, async () => {
        db.deleteServiceInstance(inst.id);
      });
    }
    await softStep(ctx, "delete_service", async () => {
      db.deleteService(ctx.input.serviceId);
    });
    return { ok: true };
  },
};

const gcEmptyServers: Step<DestroyServiceInput, { ok: true }> = {
  name: "gc_empty_servers",
  label: "GC empty servers",
  async run(ctx, prior) {
    const containers = prior["stop_and_remove_instance_container"] as { affectedServerIds: number[] } | undefined;
    const ids = containers?.affectedServerIds || [];
    for (const sid of ids) {
      await softStep(ctx, `gc_server ${sid}`, async () => {
        await db.gcServerIfEmpty(sid);
      });
    }
    return { ok: true };
  },
};

const destroyServiceOp: OpKindDefinition<DestroyServiceInput> = {
  kind: "destroy_service",
  label: "Destroy service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [
    removeEnvFromLinkedApps,
    stopAndRemoveContainers,
    deleteVolumes,
    deleteDbRows,
    gcEmptyServers,
  ],
};

registerOp(destroyServiceOp);

export default destroyServiceOp;
export type { DestroyServiceInput };
