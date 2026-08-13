import * as db from "../../shared/db.ts";
import { enqueueOperation } from "../../shared/db/operations.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import {
  pauseContainer,
  probeAppHealth,
  restartContainer,
  unpauseContainer,
} from "../../shared/remote/index.ts";
import { replicaBindHost } from "../scale/types.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type AppLifecycleInput = { appId: number };
type AppReplicaLifecycleInput = {
  appId: number;
  replicaId: number;
  action: AppLifecycleAction;
};
type AppLifecycleAction = "pause" | "unpause" | "restart";
type Precond = { skip: boolean };
type ChildrenOut = { childIds: number[]; skipped?: boolean };
type ReplicaTarget = { serverId: number };
type VerifyOut = { healthy: boolean; skipped?: boolean; error?: string };

type AppLifecycleConfig = {
  kind: string;
  label: string;
  actionName: string;
  actionLabel: string;
  action: AppLifecycleAction | ((appId: number) => Promise<{ ok: boolean; error?: string }>);
  shouldSkip: (app: AppRow) => boolean;
  skipLog: (app: AppRow) => string;
  requireReplicas?: boolean;
  syncIngress?: boolean;
};

const loadReplica: Step<AppReplicaLifecycleInput, ReplicaTarget> = {
  name: "load_replica",
  label: "Load replica",
  async run(ctx) {
    const replica = db.getReplicas(ctx.input.appId).find((row) => row.id === ctx.input.replicaId);
    if (!replica) throw new Error(`Replica ${ctx.input.replicaId} not found`);
    if (!db.getServer(replica.server_id)) {
      db.updateReplicaStatus(replica.id, "unhealthy");
      throw new Error(`Server ${replica.server_id} not found for replica ${replica.id}`);
    }
    return { serverId: replica.server_id };
  },
};

const applyReplicaAction: Step<AppReplicaLifecycleInput, { ok: true }> = {
  name: "apply_container_action",
  label: "Apply container action",
  async run(ctx) {
    const replica = db.getReplicas(ctx.input.appId).find((row) => row.id === ctx.input.replicaId);
    if (!replica) throw new Error(`Replica ${ctx.input.replicaId} not found`);
    const server = db.getServer(replica.server_id);
    if (!server) throw new Error(`Server ${replica.server_id} not found`);
    const hostKey = server.ssh_host_key || undefined;
    if (ctx.input.action === "pause") {
      await pauseContainer(server.ipv4, replica.container_name, hostKey);
    } else if (ctx.input.action === "unpause") {
      await unpauseContainer(server.ipv4, replica.container_name, hostKey);
    } else {
      await restartContainer(server.ipv4, replica.container_name, hostKey);
    }
    return { ok: true };
  },
};

const verifyReplica: Step<AppReplicaLifecycleInput, VerifyOut> = {
  name: "verify_replica",
  label: "Verify replica",
  async run(ctx) {
    if (ctx.input.action === "pause") return { healthy: true, skipped: true };
    const app = db.getApp(ctx.input.appId);
    const replica = db.getReplicas(ctx.input.appId).find((row) => row.id === ctx.input.replicaId);
    if (!app || !replica) throw new Error("App or replica disappeared during lifecycle action");
    const server = db.getServer(replica.server_id);
    if (!server) return { healthy: false, error: `Server ${replica.server_id} not found` };
    const health = await probeAppHealth(
      app,
      server.ipv4,
      replica.container_name,
      replicaBindHost(server),
      replica.host_port,
      5,
      server.ssh_host_key || undefined,
    );
    return { healthy: health.healthy, error: health.error };
  },
};

const persistReplicaState: Step<AppReplicaLifecycleInput, { status: string }> = {
  name: "persist_replica_state",
  label: "Persist replica state",
  async run(ctx, prior) {
    const status = ctx.input.action === "pause"
      ? "paused"
      : (prior["verify_replica"] as VerifyOut | undefined)?.healthy ? "running" : "unhealthy";
    db.updateReplicaStatus(ctx.input.replicaId, status);
    if (status === "unhealthy") {
      const detail = (prior["verify_replica"] as VerifyOut | undefined)?.error;
      throw new Error(detail || `Replica ${ctx.input.replicaId} is unhealthy after ${ctx.input.action}`);
    }
    return { status };
  },
};

const appReplicaLifecycleOp: OpKindDefinition<AppReplicaLifecycleInput> = {
  kind: "app_replica_lifecycle",
  label: "Apply app replica lifecycle action",
  // The parent holds the app key for the whole fan-out. Server keys serialize
  // sibling work that happens to share a host without deadlocking on the
  // parent's app lock.
  resourceKeys: (input) => {
    const replica = db.getReplicas(input.appId).find((row) => row.id === input.replicaId);
    return replica ? [`server:${replica.server_id}`] : [];
  },
  steps: [loadReplica, applyReplicaAction, verifyReplica, persistReplicaState],
};

registerOp(appReplicaLifecycleOp as OpKindDefinition<any>);

export function makeAppLifecycleOp(config: AppLifecycleConfig): OpKindDefinition<AppLifecycleInput> {
  const checkPrecondition: Step<AppLifecycleInput, Precond> = {
    name: "check_precondition",
    label: "Check current state",
    async run(ctx) {
      const app = db.getApp(ctx.input.appId);
      if (!app) throw new Error(`app ${ctx.input.appId} not found`);
      if (config.shouldSkip(app)) {
        ctx.log(config.skipLog(app));
        return { skip: true };
      }
      return { skip: false };
    },
  };

  const enqueueReplicaActions: Step<AppLifecycleInput, ChildrenOut> = {
    name: config.actionName,
    label: config.actionLabel,
    async run(ctx, prior) {
      const pre = prior["check_precondition"] as Precond | undefined;
      if (pre?.skip) return { childIds: [], skipped: true };
      const replicas = db.getReplicas(ctx.input.appId);
      if (config.requireReplicas && replicas.length === 0) throw new Error("App has no replicas");
      // Environment reload remains a rolling, replica-coupled convergence
      // routine (image distribution, drain/ingress, attestation). Keep that
      // specialized routine behind the same operation wrapper while simple
      // lifecycle actions fan out into durable child operations below.
      if (typeof config.action === "function") {
        const result = await config.action(ctx.input.appId);
        if (!result.ok) throw new Error(result.error || `${config.kind} returned ok=false`);
        return { childIds: [] };
      }
      const childIds = replicas.map((replica) => enqueueOperation({
        kind: "app_replica_lifecycle",
        resourceKeys: [`server:${replica.server_id}`],
        input: { appId: ctx.input.appId, replicaId: replica.id, action: config.action },
        trigger: ctx.trigger,
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: `op:${ctx.opId}:app-replica:${replica.id}:${config.action}`,
      }).id);
      return { childIds };
    },
  };

  const awaitReplicaActions: Step<AppLifecycleInput, { ok: true; skipped?: boolean }> = {
    name: "await_replica_actions",
    label: "Wait for replicas",
    async run(ctx, prior) {
      const children = prior[config.actionName] as ChildrenOut | undefined;
      if (!children || children.skipped || children.childIds.length === 0) {
        return { ok: true, skipped: true };
      }
      await awaitChildren(ctx, { childIds: children.childIds });
      return { ok: true };
    },
  };

  const finalizeState: Step<AppLifecycleInput, { status: string; skipped?: boolean }> = {
    name: "finalize_state",
    label: "Finalize app state",
    async run(ctx, prior) {
      const pre = prior["check_precondition"] as Precond | undefined;
      if (pre?.skip) return { status: db.getApp(ctx.input.appId)?.status || "unknown", skipped: true };
      const replicas = db.getReplicas(ctx.input.appId);
      if (typeof config.action === "function") {
        return { status: db.getApp(ctx.input.appId)?.status || "unknown" };
      }
      const status = config.action === "pause"
        ? "paused"
        : replicas.length === 0 ? "stopped"
        : replicas.every((replica) => replica.status === "running") ? "running" : "unhealthy";
      db.updateAppStatus(ctx.input.appId, status);
      if (config.syncIngress) {
        try {
          await syncAppIngress(ctx.input.appId);
        } catch (error) {
          ctx.log(`Ingress sync warning after ${config.action}: ${error}`);
        }
      }
      return { status };
    },
  };

  const op: OpKindDefinition<AppLifecycleInput> = {
    kind: config.kind,
    label: config.label,
    resourceKeys: (input) => [`app:${input.appId}`],
    steps: [checkPrecondition, enqueueReplicaActions, awaitReplicaActions, finalizeState],
  };

  registerOp(op as OpKindDefinition<any>);
  return op;
}

export { appReplicaLifecycleOp };
export type { AppLifecycleInput, AppReplicaLifecycleInput };
