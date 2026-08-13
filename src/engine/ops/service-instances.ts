import * as db from "../../shared/db.ts";
import { enqueueOperation } from "../../shared/db/operations.ts";
import {
  pauseContainer,
  restartContainer,
  serviceHealthCheck,
  unpauseContainer,
} from "../../shared/remote/index.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";

type ServiceLifecycleInput = { serviceId: number };
type ServiceLifecycleAction = "pause" | "unpause" | "restart";
type ServiceInstanceActionInput = {
  serviceId: number;
  instanceId: number;
  action: ServiceLifecycleAction;
};
type Precond = { skip: boolean };
type ChildrenOut = { childIds: number[]; skipped?: boolean };
type VerifyOut = { healthy: boolean; skipped?: boolean; error?: string };

type ServiceLifecycleConfig = {
  kind: string;
  label: string;
  actionName: string;
  actionLabel: string;
  action: ServiceLifecycleAction;
  shouldSkip: (status: string) => boolean;
  skipLog: (name: string, status: string) => string;
  requireInstances?: boolean;
};

const loadInstance: Step<ServiceInstanceActionInput, { serverId: number }> = {
  name: "load_instance",
  label: "Load service instance",
  async run(ctx) {
    const instance = db.getServiceInstance(ctx.input.instanceId);
    if (!instance || instance.service_id !== ctx.input.serviceId) {
      throw new Error(`Service instance ${ctx.input.instanceId} not found`);
    }
    if (!db.getServer(instance.server_id)) {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      db.updateServiceStatus(ctx.input.serviceId, "unhealthy");
      throw new Error(`Server ${instance.server_id} not found for service instance ${instance.id}`);
    }
    return { serverId: instance.server_id };
  },
};

const applyInstanceAction: Step<ServiceInstanceActionInput, { ok: true }> = {
  name: "apply_container_action",
  label: "Apply container action",
  async run(ctx) {
    const instance = db.getServiceInstance(ctx.input.instanceId);
    if (!instance || instance.service_id !== ctx.input.serviceId) {
      throw new Error(`Service instance ${ctx.input.instanceId} not found`);
    }
    const server = db.getServer(instance.server_id);
    if (!server) throw new Error(`Server ${instance.server_id} not found`);
    const hostKey = server.ssh_host_key || undefined;
    try {
      if (ctx.input.action === "pause") {
        await pauseContainer(server.ipv4, instance.container_name, hostKey);
      } else if (ctx.input.action === "unpause") {
        await unpauseContainer(server.ipv4, instance.container_name, hostKey);
      } else {
        await restartContainer(server.ipv4, instance.container_name, hostKey);
      }
    } catch (error) {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      db.updateServiceStatus(ctx.input.serviceId, "unhealthy");
      throw error;
    }
    return { ok: true };
  },
};

const verifyInstance: Step<ServiceInstanceActionInput, VerifyOut> = {
  name: "verify_instance",
  label: "Verify service instance",
  async run(ctx) {
    if (ctx.input.action === "pause") return { healthy: true, skipped: true };
    const service = db.getService(ctx.input.serviceId);
    const instance = db.getServiceInstance(ctx.input.instanceId);
    if (!service || !instance || instance.service_id !== service.id) {
      throw new Error("Service or instance disappeared during lifecycle action");
    }
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) return { healthy: false, error: `Unknown service type ${service.service_type}` };
    const server = db.getServer(instance.server_id);
    if (!server) return { healthy: false, error: `Server ${instance.server_id} not found` };
    const health = await serviceHealthCheck(
      server.ipv4,
      instance.container_name,
      catalog.healthCmd,
      5,
      server.ssh_host_key || undefined,
    );
    return { healthy: health.healthy, error: health.error };
  },
};

const persistInstanceState: Step<ServiceInstanceActionInput, { status: string }> = {
  name: "persist_instance_state",
  label: "Persist service instance state",
  async run(ctx, prior) {
    const status = ctx.input.action === "pause"
      ? "paused"
      : (prior["verify_instance"] as VerifyOut | undefined)?.healthy ? "running" : "unhealthy";
    db.updateServiceInstanceStatus(ctx.input.instanceId, status);
    if (status === "unhealthy") {
      db.updateServiceStatus(ctx.input.serviceId, "unhealthy");
      const detail = (prior["verify_instance"] as VerifyOut | undefined)?.error;
      throw new Error(detail || `Service instance ${ctx.input.instanceId} is unhealthy after ${ctx.input.action}`);
    }
    return { status };
  },
};

const serviceInstanceLifecycleOp: OpKindDefinition<ServiceInstanceActionInput> = {
  kind: "service_instance_lifecycle",
  label: "Apply service instance lifecycle action",
  resourceKeys: (input) => {
    const instance = db.getServiceInstance(input.instanceId);
    return instance ? [`server:${instance.server_id}`] : [];
  },
  steps: [loadInstance, applyInstanceAction, verifyInstance, persistInstanceState],
};

registerOp(serviceInstanceLifecycleOp as OpKindDefinition<any>);

export function makeServiceLifecycleOp(
  config: ServiceLifecycleConfig,
): OpKindDefinition<ServiceLifecycleInput> {
  const checkPrecondition: Step<ServiceLifecycleInput, Precond> = {
    name: "check_precondition",
    label: "Check current state",
    async run(ctx) {
      const service = db.getService(ctx.input.serviceId);
      if (!service) throw new Error("Service not found");
      if (config.shouldSkip(service.status)) {
        ctx.log(config.skipLog(service.name, service.status));
        return { skip: true };
      }
      return { skip: false };
    },
  };

  const enqueueActions: Step<ServiceLifecycleInput, ChildrenOut> = {
    name: config.actionName,
    label: config.actionLabel,
    async run(ctx, prior) {
      if ((prior["check_precondition"] as Precond | undefined)?.skip) {
        return { childIds: [], skipped: true };
      }
      const instances = db.getServiceInstances(ctx.input.serviceId);
      if (config.requireInstances && instances.length === 0) throw new Error("Service has no instances");
      return {
        childIds: instances.map((instance) => enqueueOperation({
          kind: "service_instance_lifecycle",
          resourceKeys: [`server:${instance.server_id}`],
          input: { serviceId: ctx.input.serviceId, instanceId: instance.id, action: config.action },
          trigger: ctx.trigger,
          triggeredBy: ctx.triggeredBy,
          parentId: ctx.opId,
          idempotencyKey: `op:${ctx.opId}:service-instance:${instance.id}:${config.action}`,
        }).id),
      };
    },
  };

  const awaitActions: Step<ServiceLifecycleInput, { ok: true; skipped?: boolean }> = {
    name: "await_instance_actions",
    label: "Wait for service instances",
    async run(ctx, prior) {
      const children = prior[config.actionName] as ChildrenOut | undefined;
      if (!children || children.skipped || children.childIds.length === 0) {
        return { ok: true, skipped: true };
      }
      await awaitChildren(ctx, { childIds: children.childIds });
      return { ok: true };
    },
  };

  const finalizeState: Step<ServiceLifecycleInput, { status: string; skipped?: boolean }> = {
    name: "finalize_state",
    label: "Finalize service state",
    async run(ctx, prior) {
      if ((prior["check_precondition"] as Precond | undefined)?.skip) {
        return { status: db.getService(ctx.input.serviceId)?.status || "unknown", skipped: true };
      }
      const instances = db.getServiceInstances(ctx.input.serviceId);
      const status = config.action === "pause"
        ? "paused"
        : instances.length > 0 && instances.every((instance) => instance.status === "running")
        ? "running"
        : "unhealthy";
      db.updateServiceStatus(ctx.input.serviceId, status);
      return { status };
    },
  };

  const op: OpKindDefinition<ServiceLifecycleInput> = {
    kind: config.kind,
    label: config.label,
    resourceKeys: (input) => [`service:${input.serviceId}`],
    steps: [checkPrecondition, enqueueActions, awaitActions, finalizeState],
  };
  registerOp(op as OpKindDefinition<any>);
  return op;
}

export { serviceInstanceLifecycleOp };
export type { ServiceLifecycleInput, ServiceInstanceActionInput };
