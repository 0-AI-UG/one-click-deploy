// Per-container health checks run in parallel by the reconciler each tick.
// Replicas and service instances have separate check paths (the replica path
// has a recreate fallback + auto-restart bookkeeping). No orchestration lives
// here — the reconciler decides which containers to check and applies status
// propagation.

import * as db from "../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow, ServiceRow, ServiceInstanceRow } from "../shared/db.ts";
import {
  sshExec, probeAppHealth, restartContainer,
  serviceHealthCheck, startAppReplica,
} from "../shared/remote/index.ts";
import { resolveAppEnvVars } from "../shared/env-crypto.ts";
import { getCatalogEntry } from "../shared/services/catalog.ts";
import { replicaBindHost, appReplicaRunOpts } from "./scale/types.ts";
import { currentHolder } from "./scheduler.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

const UNHEALTHY_RESTART_THRESHOLD = 2;

/**
 * Last-resort recovery when `docker restart` can't bring a replica back — the
 * container was removed out-of-band, or it's wedged in a state containerd
 * can't kill ("tried to kill container, but did not receive an exit event").
 * Force-remove it and re-run from the existing `:latest` image. Requires the
 * image to still be present; a genuinely missing image needs a full redeploy
 * from source, so we surface that as an error rather than silently failing.
 */
async function recreateReplica(
  server: ServerRow,
  app: AppRow,
  replica: ReplicaRow,
  hostKey: string | undefined,
): Promise<void> {
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
  const image = `${app.name}:latest`;
  const present = await sshExec(server.ipv4, asUser(`docker image inspect ${image} >/dev/null 2>&1 && echo yes || echo no`), hostKey);
  if (present.stdout.trim() !== "yes") {
    throw new Error(`image ${image} not present — redeploy required`);
  }
  const envVars = await resolveAppEnvVars(app);
  const envFilePath = Object.keys(envVars).length > 0 ? `/home/deploy/apps/${app.name}/.env.deploy` : undefined;
  // rm -f (startAppReplica's default) clears both the missing-container and
  // wedged-container cases before re-running. If the wedged container also
  // resists removal, the run fails on the name/port conflict and we surface
  // it (dockerd-level intervention).
  await startAppReplica(server.ipv4, {
    ...appReplicaRunOpts(app, server, { containerName: replica.container_name, hostPort: replica.host_port, envFilePath }),
  }, hostKey);
  log("health", `recreated ${replica.container_name} from ${image}`);
}

/**
 * Statuses that mean a container is intentionally not serving traffic. A
 * pause/stop/sleep op can land while a health check is already in flight
 * (ticks snapshot replicas before ops mutate them), so check results must be
 * re-validated against the live row before any status write or restart —
 * otherwise the reconciler clobbers the paused status and auto-restarts a
 * deliberately paused container.
 */
export const HEALTH_EXEMPT_STATUSES = new Set(["paused", "stopped", "sleeping", "waking"]);

export async function checkReplicaHealth(
  replica: ReplicaRow,
  app: AppRow,
  server: ServerRow,
): Promise<void> {
  if (!server.private_ipv4) return;
  const hostKey = server.ssh_host_key || undefined;
  const bindHost = replicaBindHost(server);
  try {
    const check = await probeAppHealth(app, server.ipv4, replica.container_name, bindHost, replica.host_port, 1, hostKey);

    const current = db.getReplica(replica.id);
    if (!current || HEALTH_EXEMPT_STATUSES.has(current.status)) return;
    // Never fight an in-flight engine op holding this app's lock. A deploy /
    // rolling / migrate / scale-down op puts replicas through transient states
    // (draining, deploying, a container it's about to remove) that a health
    // check would misread as unhealthy and "recover" — restarting or recreating
    // the very container the op is tearing down. The op owns the app; defer.
    if (currentHolder(`app:${app.id}`)) return;

    if (check.healthy) {
      db.updateReplicaStatus(replica.id, "running");
      db.touchReplicaHealth(replica.id);
      db.resetUnhealthyTicks(replica.id);
    } else {
      db.updateReplicaStatus(replica.id, "unhealthy");
      const ticks = db.incrementUnhealthyTicks(replica.id);
      log("health", `replica ${replica.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        const currentApp = db.getApp(app.id);
        if (!currentApp || (currentApp.status !== "running" && currentApp.status !== "unhealthy")) {
          log("health", `skipping auto-restart of ${replica.container_name}: app status is ${currentApp?.status ?? "gone"}`);
          return;
        }
        log("health", `auto-restarting ${replica.container_name}`);
        try {
          await restartContainer(server.ipv4, replica.container_name, hostKey);
          db.resetUnhealthyTicks(replica.id);
          db.insertScalingEvent({
            app_id: replica.app_id,
            event_type: "auto_restart",
            from_count: 0,
            to_count: 0,
            reason: `replica ${replica.container_name} unhealthy for ${ticks} ticks`,
          });
        } catch (err) {
          // `docker restart` can't recover a container that no longer exists or
          // is wedged (containerd lost its exit event). Fall back to recreate.
          log("health", `restart failed: ${err} — attempting recreate`);
          try {
            await recreateReplica(server, app, replica, hostKey);
            db.resetUnhealthyTicks(replica.id);
            db.insertScalingEvent({
              app_id: replica.app_id,
              event_type: "auto_recreate",
              from_count: 0,
              to_count: 0,
              reason: `restart failed for ${replica.container_name}; recreated from image`,
            });
          } catch (recreateErr) {
            log("health", `recreate failed for ${replica.container_name}: ${recreateErr}`);
          }
        }
      }
    }
  } catch (err) {
    log("health", `check failed for ${replica.container_name}: ${err}`);
  }
}

export async function checkServiceInstanceHealth(
  instance: ServiceInstanceRow,
  service: ServiceRow,
  server: ServerRow,
): Promise<void> {
  const hostKey = server.ssh_host_key || undefined;
  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) return;

  try {
    const check = await serviceHealthCheck(
      server.ipv4, instance.container_name, catalog.healthCmd, 1, hostKey,
    );

    const current = db.getServiceInstance(instance.id);
    if (!current || HEALTH_EXEMPT_STATUSES.has(current.status)) return;
    // Defer to any in-flight engine op holding this service's lock (see the
    // replica path above for the reasoning).
    if (currentHolder(`service:${service.id}`)) return;

    if (check.healthy) {
      db.updateServiceInstanceStatus(instance.id, "running");
      db.touchServiceInstanceHealth(instance.id);
      db.resetServiceInstanceUnhealthyTicks(instance.id);
    } else {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      const ticks = db.incrementServiceInstanceUnhealthyTicks(instance.id);
      log("health", `service instance ${instance.container_name} unhealthy (${ticks} ticks): ${check.error ?? ""}`);
      if (ticks >= UNHEALTHY_RESTART_THRESHOLD) {
        const currentService = db.getService(service.id);
        if (!currentService || currentService.status === "paused") {
          log("health", `skipping auto-restart of ${instance.container_name}: service status is ${currentService?.status ?? "gone"}`);
          return;
        }
        log("health", `auto-restarting service ${instance.container_name}`);
        try {
          await restartContainer(server.ipv4, instance.container_name, hostKey);
          db.resetServiceInstanceUnhealthyTicks(instance.id);
        } catch (err) {
          log("health", `restart failed: ${err}`);
        }
      }
    }
  } catch (err) {
    log("health", `check failed for service instance ${instance.container_name}: ${err}`);
  }
}
