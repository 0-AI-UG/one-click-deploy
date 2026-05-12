import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";
import { sshExec, restartContainer, serviceHealthCheck, pauseContainer, unpauseContainer, getContainerLogs } from "../../shared/remote/index.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import { removeServiceCaddy } from "../scale/caddy-manager.ts";

type ServiceInstance = {
  id: number;
  service_id: number;
  server_id: number;
  role: string;
  container_name: string;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  status: string;
};

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [service-lifecycle:${context}]`, ...args);
}

export async function destroyService(serviceId: number): Promise<{ ok: boolean; error?: string }> {
  log("destroy", `Destroying service id=${serviceId}`);
  try {
    const service = db.getService(serviceId);
    if (!service) throw new Error("Service not found");

    let cleanupFailed = false;
    const affectedServerIds = new Set<number>();

    // Remove injected service env vars from every environment this service was linked to
    const links = db.getServiceLinks(serviceId);
    for (const link of links) {
      try {
        const envRow = db.getEnvironment(link.environment_id);
        if (envRow) {
          const parsed = parseEnvVars(envRow.env_vars);
          const prefix = link.env_prefix || "DATABASE";
          const filtered = parsed.entries.filter((e) => !e.key.startsWith(`${prefix}_`));
          db.updateEnvironment(link.environment_id, envRow.name, serializeEnvVars(filtered));
        }
      } catch (err) {
        log("destroy", `Failed to uninject from environment ${link.environment_id}: ${err}`);
      }
    }

    // Destroy all instances
    const instances = db.getServiceInstances(serviceId);
    for (const instance of instances) {
      affectedServerIds.add(instance.server_id);
      const server = db.getServer(instance.server_id);
      if (server) {
        const hostKey = server.ssh_host_key || undefined;
        try {
          await sshExec(
            server.ipv4,
            `su - deploy -c "docker rm -f ${instance.container_name} 2>/dev/null || true"`,
            hostKey
          );
        } catch (err) {
          log("destroy", `Failed to remove container ${instance.container_name}: ${err}`);
          cleanupFailed = true;
        }
        // Clean up service directory
        try {
          await sshExec(
            server.ipv4,
            `rm -rf /home/deploy/services/${service.name}`,
            hostKey
          );
        } catch (e) {
          log("destroy", `Failed to remove service directory for ${service.name}: ${e}`);
        }
      }

      // Delete Hetzner volume
      if (instance.volume_id) {
        try {
          await getComputeProvider().volumes!.delete(instance.volume_id);
          log("destroy", `Deleted volume ${instance.volume_id}`);
        } catch (err) {
          log("destroy", `Failed to delete volume ${instance.volume_id}: ${err}`);
          cleanupFailed = true;
        }
      }

      db.deleteServiceInstance(instance.id);
    }

    // Remove Caddy route on the panel for HTTP-facing services. Best-effort —
    // a missing route is a no-op so this is safe to call unconditionally.
    try {
      const creds = JSON.parse(service.credentials || "{}");
      if (creds.domain) {
        await removeServiceCaddy(service.name);
        log("destroy", `Removed Caddy route for ${creds.domain}`);
      }
    } catch (err) {
      log("destroy", `Failed to remove Caddy route: ${err}`);
    }

    if (cleanupFailed) {
      db.updateServiceStatus(serviceId, "cleanup_failed");
      return { ok: false, error: "Some resources could not be cleaned up" };
    }

    db.deleteService(serviceId);

    // GC any servers that became empty
    for (const sid of affectedServerIds) {
      try {
        await db.gcServerIfEmpty(sid);
      } catch (err) {
        log("destroy", `gcServerIfEmpty(${sid}) failed: ${err}`);
      }
    }

    log("destroy", `Service id=${serviceId} destroyed`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("destroy", `Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function restartService(serviceId: number): Promise<{ ok: boolean; error?: string }> {
  log("restart", `Restarting service id=${serviceId}`);
  try {
    const service = db.getService(serviceId);
    if (!service) throw new Error("Service not found");
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");

    const instances = db.getServiceInstances(serviceId);
    if (instances.length === 0) throw new Error("Service has no instances");

    let allHealthy = true;
    for (const instance of instances) {
      const server = db.getServer(instance.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;

      await restartContainer(server.ipv4, instance.container_name, hostKey);

      const health = await serviceHealthCheck(
        server.ipv4, instance.container_name, catalog.healthCmd, 5, hostKey
      );
      db.updateServiceInstanceStatus(instance.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }

    db.updateServiceStatus(serviceId, allHealthy ? "running" : "unhealthy");
    log("restart", `Service id=${serviceId} restarted`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("restart", `Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function pauseService(serviceId: number): Promise<{ ok: boolean; error?: string }> {
  log("pause", `Pausing service id=${serviceId}`);
  try {
    const service = db.getService(serviceId);
    if (!service) throw new Error("Service not found");

    const instances = db.getServiceInstances(serviceId);
    for (const instance of instances) {
      const server = db.getServer(instance.server_id);
      if (!server) continue;
      await pauseContainer(server.ipv4, instance.container_name, server.ssh_host_key || undefined);
      db.updateServiceInstanceStatus(instance.id, "paused");
    }

    db.updateServiceStatus(serviceId, "paused");
    log("pause", `Service id=${serviceId} paused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("pause", `Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function unpauseService(serviceId: number): Promise<{ ok: boolean; error?: string }> {
  log("unpause", `Unpausing service id=${serviceId}`);
  try {
    const service = db.getService(serviceId);
    if (!service) throw new Error("Service not found");
    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");

    const instances = db.getServiceInstances(serviceId);
    let allHealthy = true;
    for (const instance of instances) {
      const server = db.getServer(instance.server_id);
      if (!server) { allHealthy = false; continue; }
      const hostKey = server.ssh_host_key || undefined;

      await unpauseContainer(server.ipv4, instance.container_name, hostKey);

      const health = await serviceHealthCheck(
        server.ipv4, instance.container_name, catalog.healthCmd, 5, hostKey
      );
      db.updateServiceInstanceStatus(instance.id, health.healthy ? "running" : "unhealthy");
      if (!health.healthy) allHealthy = false;
    }

    db.updateServiceStatus(serviceId, allHealthy ? "running" : "unhealthy");
    log("unpause", `Service id=${serviceId} unpaused`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("unpause", `Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function getServiceLogs(
  serviceId: number,
  instanceId?: number,
  tail = 100
): Promise<string> {
  const service = db.getService(serviceId);
  if (!service) throw new Error("Service not found");

  let instance: ServiceInstance;
  if (instanceId) {
    instance = db.getServiceInstance(instanceId) as ServiceInstance;
    if (!instance || instance.service_id !== serviceId) throw new Error("Instance not found");
  } else {
    instance = db.getPrimaryInstance(serviceId) as ServiceInstance;
    if (!instance) throw new Error("No primary instance");
  }

  const server = db.getServer(instance.server_id);
  if (!server) throw new Error("Server not found");

  return getContainerLogs(server.ipv4, instance.container_name, tail, server.ssh_host_key || undefined);
}
