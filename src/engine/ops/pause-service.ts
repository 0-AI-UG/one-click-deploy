import * as db from "../../shared/db.ts";
import { pauseContainer, pauseCompose } from "../../shared/remote/index.ts";
import { forEachServiceInstance } from "./service-instances.ts";

const SERVICES_BASE_DIR = "/home/deploy/services";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type PauseServiceInput = { serviceId: number };
type Precond = { alreadyInTarget: boolean };

const checkPrecondition: Step<PauseServiceInput, Precond> = {
  name: "check_precondition",
  label: "Check current state",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    if (service.status === "paused") {
      ctx.log(`service ${service.name} already paused — no work needed`);
      return { alreadyInTarget: true };
    }
    return { alreadyInTarget: false };
  },
};

const pauseAllInstances: Step<PauseServiceInput, { ok: true; skipped?: boolean }> = {
  name: "pause_container",
  label: "Pause containers",
  async run(ctx, prior) {
    const pre = prior["check_precondition"] as Precond | undefined;
    if (pre?.alreadyInTarget) return { ok: true, skipped: true };
    // Docker pause is idempotent enough: it handles "already paused".
    await forEachServiceInstance(ctx.input.serviceId, {
      withHealth: false,
      baseDir: SERVICES_BASE_DIR,
      plain: (server, inst, hostKey) => pauseContainer(server.ipv4, inst.container_name, hostKey),
      compose: (server, inst, hostKey, baseDir) => pauseCompose(server.ipv4, inst.container_name, hostKey, baseDir),
    });
    return { ok: true };
  },
};

const pauseServiceOp: OpKindDefinition<PauseServiceInput> = {
  kind: "pause_service",
  label: "Pause service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [checkPrecondition, pauseAllInstances],
};

registerOp(pauseServiceOp as OpKindDefinition<any>);

export default pauseServiceOp;
export type { PauseServiceInput };
