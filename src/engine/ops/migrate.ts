import * as db from "../../shared/db.ts";
import { migrateReplica, type MigrateResult, rollbackMigrateWithVolume, type VolumeMigrationContext } from "../scale/migrate.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { sshExec, healthCheck, containerRunningCheck } from "../../shared/remote/index.ts";
import { replicaBindHost } from "../scale/types.ts";
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
    if (replica.server_id === ctx.input.targetServerId) {
      throw new Error("Replica is already on the target server");
    }
    return { sourceServerId: replica.server_id };
  },
};

// For volume-backed apps we must verify the source can rebuild/serve the image
// BEFORE anything destructive runs. Otherwise a failed scaleUp on target leaves
// the app with no running container (image gone from source, volume detached).
const preflightImage: Step<MigrateInput, PreflightOut> = {
  name: "preflight_image",
  label: "Preflight image availability",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (!app.volume_id) return { ok: true }; // stateless path is safe
    if (app.git_repo) {
      ctx.log(`Volume-backed app has git_repo; rebuild on target is available as fallback`);
      return { ok: true };
    }
    const replica = db.getReplicas(ctx.input.appId).find((r) => r.id === ctx.input.replicaId);
    if (!replica) throw new Error("Replica not found");
    const sourceServer = db.getServer(replica.server_id);
    if (!sourceServer) throw new Error("Source server not found");
    const probe = `su - deploy -c ${JSON.stringify(`docker image inspect ${app.name}:latest >/dev/null 2>&1`)}`;
    const res = await sshExec(sourceServer.ipv4, probe, sourceServer.ssh_host_key || undefined);
    if (res.exitCode !== 0) {
      throw new Error(
        `Cannot migrate volume-backed app: image '${app.name}:latest' is missing on source server '${sourceServer.name}' and no git_repo is configured for rebuild. Redeploy first.`,
      );
    }
    return { ok: true };
  },
};

const markDraining: Step<MigrateInput, DrainOut> = {
  name: "mark_draining",
  label: "Drain replica",
  async run(ctx) {
    db.updateReplicaStatus(ctx.input.replicaId, "draining");
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress sync during drain failed (continuing): ${err}`);
    }
    return { ok: true };
  },
  async compensate(ctx) {
    // Best-effort: if the transfer failed, restore the replica's routing.
    try { db.updateReplicaStatus(ctx.input.replicaId, "running"); } catch { /* ignore */ }
    try { await syncAppIngress(ctx.input.appId); } catch { /* ignore */ }
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
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    const replica = db.getReplicas(ctx.input.appId).find((r) => r.id === ctx.input.replicaId);
    if (!replica) throw new Error("Replica not found after migration");
    const server = db.getServer(replica.server_id);
    if (!server) throw new Error("Target server not found after migration");
    const bindAddr = replicaBindHost(server);
    const hostKey = server.ssh_host_key || undefined;
    const health = app.health_check
      ? await healthCheck(server.ipv4, replica.container_name, bindAddr, replica.host_port, 5, hostKey)
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
  steps: [loadAndValidate, preflightImage, markDraining, performMigration, verifyReplicaHealthy, syncIngressStep, recordEvent, gcEmptyServers],
};

registerOp(migrateOp as OpKindDefinition<any>);

export default migrateOp;
export type { MigrateInput };
