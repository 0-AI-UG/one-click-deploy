import * as db from "../../shared/db.ts";
import { unpauseContainer, serviceHealthCheck, unpauseCompose, composeHealthCheck } from "../../shared/remote/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import { replicaBindHost } from "../scale/types.ts";

const SERVICES_BASE_DIR = "/home/deploy/services";
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
    const service = db.getService(ctx.input.serviceId);
    if (!service) throw new Error("Service not found");
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");
    const isCompose = service.deploy_kind === "compose";
    const instances = db.getServiceInstances(ctx.input.serviceId);
    let allHealthy = true;
    for (const inst of instances) {
      const server = db.getServer(inst.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;
      let health;
      if (isCompose) {
        await unpauseCompose(server.ipv4, inst.container_name, hostKey, SERVICES_BASE_DIR);
        health = await composeHealthCheck(
          server.ipv4, inst.container_name, replicaBindHost(server), inst.host_port, 5, hostKey, SERVICES_BASE_DIR,
        );
      } else {
        await unpauseContainer(server.ipv4, inst.container_name, hostKey);
        health = await serviceHealthCheck(
          server.ipv4, inst.container_name, catalog.healthCmd, 5, hostKey,
        );
      }
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
  steps: [checkPrecondition, unpauseAllInstances],
};

registerOp(unpauseServiceOp as OpKindDefinition<any>);

export default unpauseServiceOp;
export type { UnpauseServiceInput };
