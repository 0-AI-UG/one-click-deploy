import * as db from "../../shared/db.ts";
import type { ServerRow, ServiceInstanceRow } from "../../shared/db.ts";
import { serviceHealthCheck } from "../../shared/remote/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";

type InstanceAction = (
  server: ServerRow,
  inst: ServiceInstanceRow,
  hostKey: string | undefined,
) => Promise<void>;

type ForEachOptions = {
  /** Action to run against each instance's container. */
  plain: InstanceAction;
  /**
   * When true, run a health check after each action and aggregate running/unhealthy
   * status. When false (pause), skip the health check + catalog guard and set 'paused'.
   */
  withHealth: boolean;
  /** When true, throw if the service has no instances (restart). */
  requireInstances?: boolean;
};

/**
 * Fan out an instance-level action across every instance of a service, resolving
 * the server per instance and aggregating status.
 */
export async function forEachServiceInstance(
  serviceId: number,
  opts: ForEachOptions,
): Promise<{ allHealthy: boolean }> {
  const service = db.getService(serviceId);
  if (!service) throw new Error("Service not found");

  const catalog = opts.withHealth ? getCatalogEntry(service.service_type) : null;
  if (opts.withHealth && !catalog) throw new Error("Unknown service type");

  const instances = db.getServiceInstances(serviceId);
  if (opts.requireInstances && instances.length === 0) {
    throw new Error("Service has no instances");
  }

  let allHealthy = true;
  for (const inst of instances) {
    const server = db.getServer(inst.server_id);
    if (!server) {
      if (opts.withHealth) allHealthy = false;
      continue;
    }
    const hostKey = server.ssh_host_key || undefined;
    await opts.plain(server, inst, hostKey);
    if (opts.withHealth) {
      const health = await serviceHealthCheck(
        server.ipv4, inst.container_name, catalog!.healthCmd, 5, hostKey,
      );
      db.updateServiceInstanceStatus(inst.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    } else {
      db.updateServiceInstanceStatus(inst.id, "paused");
    }
  }

  db.updateServiceStatus(serviceId, opts.withHealth ? (allHealthy ? "running" : "unhealthy") : "paused");
  return { allHealthy };
}
