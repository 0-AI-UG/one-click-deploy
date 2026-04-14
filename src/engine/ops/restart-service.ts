import * as db from "../../bun/db.ts";
import { restartContainer, serviceHealthCheck } from "../../bun/remote/index.ts";
import { getCatalogEntry } from "../../bun/services/catalog.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type RestartServiceInput = { serviceId: number };

const restartAllInstances: Step<RestartServiceInput, { allHealthy: boolean }> = {
  name: "restart_container",
  label: "Restart containers",
  async run(ctx) {
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");

    const instances = db.getServiceInstances(ctx.input.serviceId);
    if (instances.length === 0) throw new Error("Service has no instances");

    let allHealthy = true;
    for (const inst of instances) {
      const server = db.getServer(inst.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;
      await restartContainer(server.ipv4, inst.container_name, hostKey);
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

const restartServiceOp: OpKindDefinition<RestartServiceInput> = {
  kind: "restart_service",
  label: "Restart service",
  resourceKeys: (input) => [`service:${input.serviceId}`],
  steps: [restartAllInstances],
};

registerOp(restartServiceOp as OpKindDefinition<any>);

export default restartServiceOp;
export type { RestartServiceInput };
