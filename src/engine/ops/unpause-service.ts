import * as db from "../../shared/db.ts";
import { unpauseContainer, serviceHealthCheck } from "../../shared/remote/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type UnpauseServiceInput = { serviceId: number };

const unpauseAllInstances: Step<UnpauseServiceInput, { allHealthy: boolean }> = {
  name: "unpause_container",
  label: "Unpause containers",
  async run(ctx) {
    const service = db.getServiceUnscoped(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");
    const instances = db.getServiceInstances(ctx.input.serviceId);
    let allHealthy = true;
    for (const inst of instances) {
      const server = db.getServerUnscoped(inst.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;
      await unpauseContainer(server.ipv4, inst.container_name, hostKey);
      const health = await serviceHealthCheck(
        server.ipv4, inst.container_name, catalog.healthCmd, 5, hostKey,
      );
      db.updateServiceInstanceStatus(inst.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }
    db.updateServiceStatus(ctx.input.serviceId, allHealthy ? "running" : "unhealthy");
    return { allHealthy };
  },
};

const unpauseServiceOp: OpKindDefinition<UnpauseServiceInput> = {
  kind: "unpause_service",
  label: "Unpause service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [unpauseAllInstances],
};

registerOp(unpauseServiceOp);

export default unpauseServiceOp;
export type { UnpauseServiceInput };
