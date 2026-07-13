import * as db from "../../shared/db.ts";
import { unpauseContainer } from "../../shared/remote/index.ts";
import { forEachServiceInstance } from "./service-instances.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type UnpauseServiceInput = { serviceId: number };
type Precond = { alreadyInTarget: boolean };

const checkPrecondition: Step<UnpauseServiceInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    if (service.status !== "paused") {
      ctx.log(`service ${service.name} is '${service.status}' (not paused) — no work needed`);
      return { alreadyInTarget: true };
    }
    return { alreadyInTarget: false };
  },
};

const unpauseAllInstances: Step<UnpauseServiceInput, { allHealthy: boolean; skipped?: boolean }> = {
  name: "unpause_container",
  label: "Unpause containers",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre?.alreadyInTarget) return { allHealthy: true, skipped: true };
    const { allHealthy } = await forEachServiceInstance(ctx.input.serviceId, {
      withHealth: true,
      plain: (server, inst, hostKey) => unpauseContainer(server.ipv4, inst.container_name, hostKey),
    });
    return { allHealthy };
  },
};

const unpauseServiceOp: OpKindDefinition<UnpauseServiceInput> = {
  kind: "unpause_service",
  label: "Unpause service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [checkPrecondition, unpauseAllInstances],
};

registerOp(unpauseServiceOp as OpKindDefinition<any>);

export default unpauseServiceOp;
export type { UnpauseServiceInput };
