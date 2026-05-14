import * as db from "../../shared/db.ts";
import { migrateReplica, type MigrateResult } from "../scale/migrate.ts";
import { syncAppCaddy } from "../scale/caddy-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type MigrateInput = { appId: number; replicaId: number; targetServerId: number };

// migrateReplica() is the core routine: it pulls the image, starts on target,
// stops on source, swaps replica rows, and (for volume apps) detaches/attaches
// the Hetzner volume with its own internal rollback. We bracket it with
// `mark_draining` and `record_event` steps so those bookkeeping concerns are
// visible in the audit log; the transfer itself stays atomic.

type ValidateOut = { sourceServerId: number };
type DrainOut = { ok: true };
type TransferOut = Extract<MigrateResult, { ok: true }>;

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
    if (replica.server_id === ctx.input.targetServerId) {
      throw new Error("Replica is already on the target server");
    }
    return { sourceServerId: replica.server_id };
  },
};

const markDraining: Step<MigrateInput, DrainOut> = {
  name: "mark_draining",
  label: "Drain replica",
  async run(ctx) {
    db.updateReplicaStatus(ctx.input.replicaId, "draining");
    try {
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync during drain failed (continuing): ${err}`);
    }
    return { ok: true };
  },
  async compensate(ctx) {
    // Best-effort: if the transfer failed, restore the replica's routing.
    try { db.updateReplicaStatus(ctx.input.replicaId, "running"); } catch { /* ignore */ }
    try { await syncAppCaddy(ctx.input.appId); } catch { /* ignore */ }
  },
};

const performMigration: Step<MigrateInput, TransferOut> = {
  name: "perform_migration",
  label: "Migrate replica",
  async run(ctx) {
    const result = await migrateReplica(
      ctx.input.appId,
      ctx.input.replicaId,
      ctx.input.targetServerId,
      (step, detail) => ctx.log(`[${step}] ${detail}`),
    );
    if (!result.ok) throw new Error(result.error || "Migration failed");
    return result;
  },
};

const syncCaddyStep: Step<MigrateInput, { ok: true }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx) {
    try {
      await syncAppCaddy(ctx.input.appId);
    } catch (err) {
      ctx.log(`Caddy sync warning: ${err}`);
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
  steps: [loadAndValidate, markDraining, performMigration, syncCaddyStep, recordEvent, gcEmptyServers],
};

registerOp(migrateOp as OpKindDefinition<any>);

export default migrateOp;
export type { MigrateInput };
