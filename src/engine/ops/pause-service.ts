import * as db from "../../shared/db.ts";
import { pauseContainer } from "../../shared/remote/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type PauseServiceInput = { serviceId: number };

const pauseAllInstances: Step<PauseServiceInput, { ok: true }> = {
  name: "pause_container",
  label: "Pause containers",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    const instances = db.getServiceInstances(ctx.input.serviceId);
    for (const inst of instances) {
      const server = db.getServer(inst.server_id);
      if (!server) continue;
      // Docker pause is idempotent enough: `docker pause` on an already paused
      // container exits non-zero — pauseContainer handles that gracefully.
      await pauseContainer(server.ipv4, inst.container_name, server.ssh_host_key || undefined);
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
  steps: [pauseAllInstances],
};

registerOp(pauseServiceOp);

export default pauseServiceOp;
export type { PauseServiceInput };
