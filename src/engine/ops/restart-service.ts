import * as db from "../../shared/db.ts";
import { restartContainer } from "../../shared/remote/index.ts";
import { forEachServiceInstance } from "./service-instances.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RestartServiceInput = { serviceId: number };
type Precond = { runnable: boolean; reason?: string };

const checkPrecondition: Step<RestartServiceInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    if (service.status === "paused" || service.status === "deploying") {
      ctx.log(`service ${service.name} status='${service.status}' — restart skipped`);
      return { runnable: false, reason: `status=${service.status}` };
    }
    return { runnable: true };
  },
};

const restartAllInstances: Step<RestartServiceInput, { allHealthy: boolean; skipped?: boolean }> = {
  name: "restart_container",
  label: "Restart containers",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre && !pre.runnable) return { allHealthy: true, skipped: true };
    const { allHealthy } = await forEachServiceInstance(ctx.input.serviceId, {
      withHealth: true,
      requireInstances: true,
      plain: (server, inst, hostKey) => restartContainer(server.ipv4, inst.container_name, hostKey),
    });
    return { allHealthy };
  },
};

const restartServiceOp: OpKindDefinition<RestartServiceInput> = {
  kind: "restart_service",
  label: "Restart service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [checkPrecondition, restartAllInstances],
};

registerOp(restartServiceOp as OpKindDefinition<any>);

export default restartServiceOp;
export type { RestartServiceInput };
