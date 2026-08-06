import * as db from "../shared/db.ts";
import { enqueueOperation, findActiveOperationByResourceKey } from "../shared/db/operations.ts";
import { sshExec } from "../shared/remote/index.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [service-reconciler]`, ...args);
}

/** Consume services.desired_instances and repair the materialized primary.
 * Multi-instance stateful services are not supported yet; values other than 1
 * are surfaced instead of causing automatic data duplication or deletion. */
export async function reconcileServiceInstances(): Promise<void> {
  for (const snapshot of db.getServices()) {
    const key = `service:${snapshot.id}`;
    const lock = tryAcquire([key], NON_OP_HOLDER, "reconcile:service-runtime");
    if (!lock.ok) continue;
    try {
      const service = db.getService(snapshot.id);
      if (!service) continue;
      if (service.deletion_requested_at) {
        if (!findActiveOperationByResourceKey("destroy_service", key)) {
          const volumeKeys = db.getServiceInstances(service.id)
            .filter((instance) => !!instance.volume_id)
            .map((instance) => `volume:${instance.volume_id}`);
          enqueueOperation({
            kind: "destroy_service",
            resourceKeys: [key, ...volumeKeys],
            input: { serviceId: service.id },
            trigger: "reconciler",
            triggeredBy: "system:service-finalizer",
          });
          log(`${service.name}: queued deletion finalizer retry`);
        }
        continue;
      }
      if (["paused", "deploying", "cleanup_failed"].includes(service.status)) continue;
      if (findActiveOperationByResourceKey("repair_service", key)) continue;
      const instances = db.getServiceInstances(service.id);
      if (service.desired_instances !== 1) {
        db.updateServiceStatus(service.id, "unhealthy");
        log(`${service.name}: desired_instances=${service.desired_instances}; only exactly one stateful instance is safe`);
        continue;
      }
      if (instances.length !== 1) {
        db.updateServiceStatus(service.id, "unhealthy");
        log(`${service.name}: instance rows ${instances.length}/1; automatic reconstruction is unsafe without volume provenance`);
        continue;
      }
      const instance = instances[0];
      const server = db.getServer(instance.server_id);
      let needsRepair = !server || server.status !== "ready";
      if (!needsRepair && instance.unhealthy_ticks >= 2) {
        const result = await sshExec(
          server!.ipv4,
          `su - deploy -c ${JSON.stringify(`docker inspect ${instance.container_name} >/dev/null 2>&1`)}`,
          server!.ssh_host_key || undefined,
        );
        needsRepair = result.exitCode !== 0;
      }
      if (!needsRepair) continue;
      enqueueOperation({
        kind: "repair_service",
        resourceKeys: [
          key,
          `server:${instance.server_id}`,
          ...(instance.volume_id ? [`volume:${instance.volume_id}`] : []),
        ],
        input: { serviceId: service.id, instanceId: instance.id },
        trigger: "reconciler",
        triggeredBy: "system:service-reconciler",
      });
      log(`${service.name}: queued instance repair`);
    } catch (error) {
      log(`${snapshot.name}: ${error}`);
    } finally {
      release([key]);
    }
  }
}
