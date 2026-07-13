import * as db from "../../shared/db.ts";
import { parseEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";
import { sshExec, getContainerLogs, removeCompose, getComposeLogs } from "../../shared/remote/index.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";

/** Compose-kind services live here (apps use /home/deploy/apps). */
const SERVICES_BASE_DIR = "/home/deploy/services";

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

// Single imperative teardown for a service. The destroy_server cascade drives
// this directly; the standalone destroy_service op reimplements the same steps
// as a saga (see ops/destroy-service.ts).
export async function destroyServiceCore(serviceId: number): Promise<{ ok: boolean; error?: string }> {
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
          if (service.deploy_kind === "compose") {
            await removeCompose(server.ipv4, instance.container_name, true, hostKey, SERVICES_BASE_DIR);
          } else {
            await sshExec(
              server.ipv4,
              `su - deploy -c "docker rm -f ${instance.container_name} 2>/dev/null || true"`,
              hostKey
            );
          }
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
          await hetzner.volumes!.delete(instance.volume_id);
          log("destroy", `Deleted volume ${instance.volume_id}`);
        } catch (err) {
          log("destroy", `Failed to delete volume ${instance.volume_id}: ${err}`);
          cleanupFailed = true;
        }
      }

      db.deleteServiceInstance(instance.id);
    }

    // Remove the panel ingress route for HTTP-facing services. Best-effort —
    // a missing route is a no-op so this is safe to call unconditionally.
    try {
      const creds = JSON.parse(service.credentials || "{}");
      if (creds.domain) {
        await syncAllTraefik();
        log("destroy", `Removed ingress route for ${creds.domain}`);
      }
    } catch (err) {
      log("destroy", `Failed to remove ingress route: ${err}`);
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

  const hostKey = server.ssh_host_key || undefined;
  if (service.deploy_kind === "compose") {
    return getComposeLogs(server.ipv4, instance.container_name, tail, hostKey, SERVICES_BASE_DIR);
  }
  return getContainerLogs(server.ipv4, instance.container_name, tail, hostKey);
}
