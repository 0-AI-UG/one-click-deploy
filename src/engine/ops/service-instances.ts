import * as db from "../../shared/db.ts";
import type { ServerRow, ServiceInstanceRow } from "../../shared/db.ts";
import { serviceHealthCheck, composeHealthCheck } from "../../shared/remote/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import { replicaBindHost } from "../scale/types.ts";

type InstanceAction = (
  server: ServerRow,
  inst: ServiceInstanceRow,
  hostKey: string | undefined,
  baseDir: string,
) => Promise<void>;

type ForEachOptions = {
  /** Action for single-container (`docker run`) services. */
  plain: InstanceAction;
  /** Action for bundled `docker-compose` services. */
  compose: InstanceAction;
  /** Base dir for compose projects, passed through to compose actions/health checks. */
  baseDir: string;
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
 * the server per instance, branching on `deploy_kind`, and aggregating status.
 */
export async function forEachServiceInstance(
  serviceId: number,
  opts: ForEachOptions,
): Promise<{ allHealthy: boolean }> {
  const service = db.getService(serviceId);
  if (!service) throw new Error("Service not found");

  const catalog = opts.withHealth ? getCatalogEntry(service.service_type) : null;
  if (opts.withHealth && !catalog) throw new Error("Unknown service type");

  const isCompose = service.deploy_kind === "compose";
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
    if (isCompose) {
      await opts.compose(server, inst, hostKey, opts.baseDir);
    } else {
      await opts.plain(server, inst, hostKey, opts.baseDir);
    }
    if (opts.withHealth) {
      const health = isCompose
        ? await composeHealthCheck(
            server.ipv4, inst.container_name, replicaBindHost(server), inst.host_port, 5, hostKey, opts.baseDir,
          )
        : await serviceHealthCheck(
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
