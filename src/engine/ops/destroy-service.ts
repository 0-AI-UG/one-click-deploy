import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";
import { registerOp } from "./registry.ts";
import { softStep, runDbCleanupGate, makeGcEmptyServersStep } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyServiceInput = {
  serviceId: number;
  /** Failed-deploy cleanup may expire automatically after the recovery window. */
  retentionClass?: "user" | "provisional";
};

const removeEnvFromLinkedEnvironments: Step<DestroyServiceInput, { ok: true }> = {
  name: "remove_env_vars_from_linked_environments",
  label: "Remove env vars from linked environments",
  async run(ctx) {
    const links = db.getServiceLinks(ctx.input.serviceId);
    for (const link of links) {
      await softStep(ctx, `uninject_env env#${link.environment_id}`, async () => {
        const envRow = db.getEnvironment(link.environment_id);
        if (!envRow) return;
        const parsed = parseEnvVars(envRow.env_vars);
        const prefix = link.env_prefix || "DATABASE";
        const removedKeys = parsed.entries
          .filter((e) => e.key.startsWith(`${prefix}_`))
          .map((e) => e.key);
        const filtered = parsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
        db.updateEnvironment(link.environment_id, envRow.name, serializeEnvVars(filtered));
        const stale = db.markAppsEnvironmentStaleForKeys(link.environment_id, removedKeys);
        if (stale > 0) ctx.log(`Marked ${stale} linked app(s) stale after removing ${prefix}_*`);
      });
    }
    return { ok: true };
  },
};

const stopAndRemoveContainers: Step<DestroyServiceInput, { affectedServerIds: number[]; failed: boolean }> = {
  name: "stop_and_remove_instance_container",
  label: "Stop and remove containers",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    const instances = db.getServiceInstances(ctx.input.serviceId);
    const affected = new Set<number>();
    let failed = false;
    for (const inst of instances) {
      affected.add(inst.server_id);
      const server = db.getServer(inst.server_id);
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
  label: "Detach and retain volumes",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    const instances = db.getServiceInstances(ctx.input.serviceId);
    let failed = false;
    for (const inst of instances) {
      if (!inst.volume_id) continue;
      const r = await softStep(ctx, `delete_volume ${inst.volume_id}`, async () => {
        const compute = hetzner;
        if (inst.volume_attached) {
          // Pre-existing attached volume — detach, never delete (parity with
          // apps; service deploys only ever create volumes today, so this is
          // the safe branch for any future attach path).
          await compute.volumes?.detach(inst.volume_id);
        } else {
          await compute.volumes?.detach(inst.volume_id);
          db.retireVolume({
            providerVolumeId: inst.volume_id,
            formerResourceType: "service",
            formerResourceId: ctx.input.serviceId,
            formerResourceName: service?.name ?? `service-${ctx.input.serviceId}`,
            reason: `service destroy operation #${ctx.opId}`,
            retentionClass: ctx.input.retentionClass ?? "user",
          });
          ctx.log(`Detached volume ${inst.volume_id}; retained for recovery for 7 days`);
        }
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
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try { db.updateServiceStatus(ctx.input.serviceId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Some resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — service marked cleanup_failed`);
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

const syncIngress: Step<DestroyServiceInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Re-render Traefik ingress",
  async run(ctx) {
    // The service's public HTTP vhost (if any) is derived from DB state, so
    // once its rows are gone a full re-render drops the router. Best-effort:
    // reconcileTraefik heals any straggler on the next tick regardless.
    await softStep(ctx, "sync_traefik", async () => {
      await syncAllTraefik();
    });
    return { ok: true };
  },
};

const gcEmptyServers = makeGcEmptyServersStep<DestroyServiceInput>("stop_and_remove_instance_container");

const destroyServiceOp: OpKindDefinition<DestroyServiceInput> = {
  kind: "destroy_service",
  label: "Destroy service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [
    removeEnvFromLinkedEnvironments,
    stopAndRemoveContainers,
    deleteVolumes,
    deleteDbRows,
    syncIngress,
    gcEmptyServers,
  ],
};

registerOp(destroyServiceOp as OpKindDefinition<any>);

export default destroyServiceOp;
export type { DestroyServiceInput };
