import * as db from "../../shared/db.ts";
import { migrateReplica } from "../scale/migrate.ts";
import { syncAppCaddy } from "../scale/caddy-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type MigrateInput = { appId: number; replicaId: number; targetServerId: number };

// NOTE: The existing migrateReplica() helper is a single atomic routine that
// handles both stateless and volume-bound migration end-to-end: pull image,
// start on target, stop on source, swap replica rows, sync Caddy, and gc.
// Faithful per-step decomposition would require rewriting that function,
// which the spec explicitly forbids. We wrap it as one primary step that
// delegates to migrateReplica, plus pre/post audit steps. Partial failures
// roll back via migrateReplica's own internal rollback (volume reattach, etc.).

type RunOut = {
  sourceServerId: number;
};

const loadAndValidate: Step<MigrateInput, RunOut> = {
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

const performMigration: Step<MigrateInput, { ok: true }> = {
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
    return { ok: true };
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

const gcEmptyServers: Step<MigrateInput, { ok: true }> = {
  name: "gc_empty_servers",
  label: "GC empty servers",
  async run(ctx, prior) {
    const r = prior["load_and_validate"] as RunOut | undefined;
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
  steps: [loadAndValidate, performMigration, syncCaddyStep, gcEmptyServers],
};

registerOp(migrateOp as OpKindDefinition<any>);

export default migrateOp;
export type { MigrateInput };
