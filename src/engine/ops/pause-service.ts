import * as db from "../../shared/db.ts";
import { pauseContainer, pauseCompose } from "../../shared/remote/index.ts";

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
    const service = db.getService(ctx.input.serviceId);
    const isCompose = service?.deploy_kind === "compose";
    const instances = db.getServiceInstances(ctx.input.serviceId);
    for (const inst of instances) {
      const server = db.getServer(inst.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;
      // Docker pause is idempotent enough: it handles "already paused".
      if (isCompose) {
        await pauseCompose(server.ipv4, inst.container_name, hostKey, SERVICES_BASE_DIR);
      } else {
        await pauseContainer(server.ipv4, inst.container_name, hostKey);
      }
      db.updateServiceInstanceStatus(inst.id, "paused");
    }
    db.updateServiceStatus(ctx.input.serviceId, "paused");
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
