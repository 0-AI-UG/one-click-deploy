import * as db from "../../shared/db.ts";
import { migrateReplica, type MigrateResult, rollbackMigrateWithVolume, type VolumeMigrationContext } from "../scale/migrate.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { pullImmutableImage, healthCheck, containerRunningCheck } from "../../shared/remote/index.ts";
import { replicaBindHost } from "../scale/types.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { latestDesiredImage } from "../revision.ts";
import { requireStorageDriver } from "../storage/index.ts";

type MigrateInput = { appId: number; replicaId: number; targetServerId: number };

// migrateReplica() is the core routine: it pulls the image, starts on target,
// stops on source, swaps replica rows, and (for volume apps) detaches/attaches
// the portable storage volume with its own internal rollback. Port reservation and
// draining happen inside that routine so no traffic is removed before the
// complete target bind tuple has passed preflight.

type ValidateOut = { sourceServerId: number };
type TransferOut = Extract<MigrateResult, { ok: true }>;
type PreflightOut = { ok: true };

const loadAndValidate: Step<MigrateInput, ValidateOut> = {
  name: "load_and_validate",
  label: "Validate migration",
  async run(ctx) {
    const replica = db.getReplicas(ctx.input.appId).find((r) => r.id === ctx.input.replicaId);
    if (!replica) throw new Error("Replica not found");
    const target = db.getServer(ctx.input.targetServerId);
    if (!target || target.status !== "ready") {
      throw new Error("Target server not found or not ready");
    }
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const source = db.getServer(replica.server_id);
    if (!source) throw new Error("Source server not found");
    if (db.parseExtraVolumes(app.extra_volumes).length > 0) {
      throw new Error("Apps with host-directory mounts cannot migrate between servers");
    }
    if (app.volume_id) {
      const driver = requireStorageDriver(app.volume_driver);
      if (!driver.portable) {
        throw new Error(`Volume ${app.volume_id} uses non-portable storage driver ${driver.id}`);
      }
      if (!driver.supports(source) || !driver.supports(target)) {
        throw new Error(`Storage driver ${driver.id} does not support both migration servers`);
      }
    }
    if (replica.server_id === ctx.input.targetServerId) {
      throw new Error("Replica is already on the target server");
    }
    return { sourceServerId: replica.server_id };
  },
};

// For volume-backed apps, pull the exact registry digest to the target before
// any destructive volume move begins.
const preflightImage: Step<MigrateInput, PreflightOut> = {
  name: "preflight_image",
  label: "Preflight image availability",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (!app.volume_id) return { ok: true }; // stateless path is safe
    const image = latestDesiredImage(app);
    const target = db.getServer(ctx.input.targetServerId);
    if (!target) throw new Error("Target server not found");
    await pullImmutableImage(target.ipv4, {
      name: app.name,
      imageRef: image,
      hostKey: target.ssh_host_key || undefined,
    }, (line) => ctx.log(`[preflight-pull] ${line}`));
    return { ok: true };
  },
};

const performMigration: Step<MigrateInput, TransferOut> = {
  name: "perform_migration",
  label: "Migrate replica",
  async run(ctx) {
    // Volume migrations destroy the source container before the new one comes
    // up. If anything past that point fails, the engine's compensate path
    // can't help us — only forward steps with status='ok' have their
    // compensate hooks invoked. So we handle rollback inline here.
    const rb: VolumeMigrationContext = {};
    try {
      const result = await migrateReplica(
        ctx.input.appId,
        ctx.input.replicaId,
        ctx.input.targetServerId,
        (step, detail) => ctx.log(`[${step}] ${detail}`),
        rb,
      );
      if (!result.ok) throw new Error(result.error || "Migration failed");
      return result;
    } catch (err) {
      if (rb.withVolume) {
        try {
          await rollbackMigrateWithVolume(rb, (line) => ctx.log(line));
        } catch (rbErr) {
          ctx.log(`MANUAL RECOVERY NEEDED: volume migration rollback threw: ${rbErr}`);
        }
        try {
          await syncAppIngress(ctx.input.appId);
        } catch (ingressErr) {
          ctx.log(`Ingress resync during rollback failed: ${ingressErr}`);
        }
      }
      throw err;
    }
  },
};

const verifyReplicaHealthy: Step<MigrateInput, { ok: true; healthy: boolean }> = {
  name: "verify_replica_healthy",
  label: "Verify replica healthy",
  async run(ctx, prior) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const migrated = prior["perform_migration"] as TransferOut | undefined;
    const replica = db.getReplicas(ctx.input.appId).find((r) => r.id === migrated?.replicaId);
    if (!replica) throw new Error("Replica not found after migration");
    const server = db.getServer(replica.server_id);
    if (!server) throw new Error("Target server not found after migration");
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = app.health_check
      ? await healthCheck(server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey, app.health_check_path ?? undefined)
      : await containerRunningCheck(server.ipv4, replica.container_name, 5, hostKey);
    if (!health.healthy) {
      // Surface to the reconciler sweep — stays in cleanup_failed bucket so
      // operators see it without auto-retry.
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      throw new Error(`Replica unhealthy after migration: ${health.error || "health check failed"}`);
    }
    return { ok: true, healthy: true };
  },
};

const syncIngressStep: Step<MigrateInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const recordEvent: Step<MigrateInput, { ok: true }> = {
  name: "record_event",
  label: "Record migration event",
  async run(ctx, prior) {
    const out = prior["perform_migration"] as TransferOut | undefined;
    if (!out) return { ok: true };
    db.insertScalingEvent({
      app_id: ctx.input.appId,
      operation_id: ctx.opId,
      event_type: "migrate",
      from_count: out.fromCount,
      to_count: out.toCount,
      reason: out.withVolume
        ? `Migrated replica with volume from ${out.sourceServerName} to ${out.targetServerName}`
        : `Migrated replica from ${out.sourceServerName} to ${out.targetServerName}`,
    });
    return { ok: true };
  },
};

const gcEmptyServers: Step<MigrateInput, { ok: true }> = {
  name: "gc_empty_servers",
  label: "GC empty servers",
  async run(ctx, prior) {
    const r = prior["load_and_validate"] as ValidateOut | undefined;
    if (!r) return { ok: true };
    try {
      await db.gcServerIfEmpty(r.sourceServerId);
    } catch (err) {
      ctx.log(`gcServerIfEmpty(${r.sourceServerId}) failed: ${err}`);
    }
    return { ok: true };
  },
};

const migrateOp: OpKindDefinition<MigrateInput> = {
  kind: "migrate",
  label: "Migrate replica",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [loadAndValidate, preflightImage, performMigration, verifyReplicaHealthy, syncIngressStep, recordEvent, gcEmptyServers],
};

registerOp(migrateOp as OpKindDefinition<any>);

export default migrateOp;
export type { MigrateInput };
