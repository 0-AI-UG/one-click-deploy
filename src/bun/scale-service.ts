import * as db from "./db.ts";
import * as hetzner from "./hetzner/index.ts";
import { getCatalogEntry, buildConnectionUrl } from "./services/catalog.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [scale-service:${context}]`, ...args);
}

export async function scaleService(
  serviceId: number,
  targetInstances: number,
  onProgress?: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});
  log("scale", `Scaling service ${serviceId} to ${targetInstances} instances`);

  try {
    const service = db.getService(serviceId);
    if (!service) throw new Error("Service not found");

    const catalog = getCatalogEntry(service.service_type);
    if (!catalog) throw new Error("Unknown service type");

    if (!catalog.replication.supported) {
      return { ok: false, error: `${catalog.label} does not support replication` };
    }

    const currentInstances = db.getServiceInstances(serviceId);
    const currentCount = currentInstances.length;

    if (targetInstances === currentCount) return { ok: true };
    if (targetInstances < 1) return { ok: false, error: "Must have at least 1 instance (primary)" };

    if (targetInstances > currentCount) {
      await scaleUp(service, catalog, currentInstances, currentCount, targetInstances, emit);
    } else {
      await scaleDown(service, catalog, currentInstances, currentCount, targetInstances, emit);
    }

    db.updateServiceDesiredInstances(serviceId, targetInstances);
    log("scale", `Service ${serviceId} scaled from ${currentCount} to ${targetInstances}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("scale", `Failed to scale service ${serviceId}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function scaleUp(
  service: any,
  catalog: any,
  currentInstances: any[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn
) {
  const envVars = JSON.parse(service.env_vars || "{}");
  const primary = currentInstances.find((i: any) => i.role === "primary");
  if (!primary) throw new Error("No primary instance found");

  const primaryServer = db.getServer(primary.server_id);
  if (!primaryServer) throw new Error("Primary server not found");
  const primaryHostKey = primaryServer.ssh_host_key || undefined;

  // Determine primary host for replication — use server IP for cross-server,
  // container name for same-server
  const primaryHost = primaryServer.ipv4;
  const primaryPort = primary.host_port;

  // If adding replicas on other servers, ensure primary is accessible
  // For now, all replicas go on the same server as primary for simplicity
  // Cross-server replication would need 0.0.0.0 binding + firewall rules

  const image = `${catalog.image}:${service.version}`;

  for (let i = currentCount; i < targetCount; i++) {
    const replicaNum = i + 1;
    emit("scale", `Provisioning read replica ${replicaNum}/${targetCount}...`);

    // Use same server as primary for volume locality
    const targetServer = primaryServer;
    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Create volume for replica data
    emit("scale", `Creating volume for replica ${replicaNum}...`);
    const hetznerServerId = parseInt(targetServer.hetzner_id, 10);
    const serverLocation = targetServer.location || "nbg1";
    const vol = await hetzner.createVolume({
      name: `ocd-svc-${service.name}-r${replicaNum}-data`,
      size: 10,
      server_id: hetznerServerId,
      location: serverLocation,
    });
    await Bun.sleep(3000); // Wait for volume mount

    const hostPort = db.nextServiceHostPort(targetServer.id);
    const containerName = `${service.name}-r${replicaNum}`;
    const hostMountPath = `/mnt/ocd-svc-${service.name}-r${replicaNum}-data`;
    const volumeMount = `${hostMountPath}:${catalog.volumePath}`;

    // Generate replica env vars
    const replicaEnv = catalog.replication.makeReplicaEnv(primaryHost, primaryPort, envVars);

    // Get replica cmd override
    const replicaCmd = catalog.replication.makeReplicaCmd
      ? catalog.replication.makeReplicaCmd(primaryHost, primaryPort, envVars)
      : undefined;

    emit("scale", `Starting replica ${replicaNum}...`);
    await hetzner.pullAndRunService(
      targetServer.ipv4,
      {
        name: containerName,
        image,
        port: catalog.defaultPort,
        hostPort,
        envVars: replicaEnv,
        volumeMount,
        cmd: replicaCmd,
      },
      targetHostKey
    );

    // Insert instance record
    db.insertServiceInstance({
      service_id: service.id,
      server_id: targetServer.id,
      role: "replica",
      container_name: containerName,
      host_port: hostPort,
      volume_id: String(vol.id),
      volume_mount: volumeMount,
      status: "deploying",
    });

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const healthCmd = catalog.replication.replicaHealthCmd || catalog.healthCmd;
    const health = await hetzner.serviceHealthCheck(
      targetServer.ipv4, containerName, healthCmd, 10, targetHostKey
    );

    const instance = db.getServiceInstances(service.id).find(
      (inst: any) => inst.container_name === containerName
    );
    if (instance) {
      db.updateServiceInstanceStatus(instance.id, health.healthy ? "running" : "unhealthy");
    }

    emit("scale", `Replica ${replicaNum} ${health.healthy ? "healthy" : "started (may still be syncing)"}`);
  }

  // Update linked apps with replica URLs
  await updateLinkedAppsReplicaUrls(service);
}

async function scaleDown(
  service: any,
  catalog: any,
  currentInstances: any[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn
) {
  // Never remove primary — only remove replicas, newest first
  const replicas = currentInstances
    .filter((i: any) => i.role === "replica")
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const toRemove = replicas.slice(0, currentCount - targetCount);

  for (const instance of toRemove) {
    emit("scale", `Removing replica ${instance.container_name}...`);

    const server = db.getServer(instance.server_id);
    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      try {
        await hetzner.sshExec(
          server.ipv4,
          `su - deploy -c "docker rm -f ${instance.container_name} 2>/dev/null || true"`,
          hostKey
        );
      } catch (err) {
        log("scale", `Failed to remove container ${instance.container_name}: ${err}`);
      }
    }

    if (instance.volume_id) {
      try {
        await hetzner.deleteVolume(instance.volume_id);
      } catch (err) {
        log("scale", `Failed to delete volume ${instance.volume_id}: ${err}`);
      }
    }

    db.deleteServiceInstance(instance.id);
    emit("scale", `Replica ${instance.container_name} removed`);
  }

  // Update linked apps
  await updateLinkedAppsReplicaUrls(service);
}

/** Update DATABASE_REPLICA_URLS in all linked apps after scaling */
async function updateLinkedAppsReplicaUrls(service: any): Promise<void> {
  const catalog = getCatalogEntry(service.service_type);
  if (!catalog) return;

  const links = db.getServiceLinks(service.id);
  const replicas = db.getReplicaInstances(service.id);
  const envVars = JSON.parse(service.env_vars || "{}");

  for (const link of links) {
    try {
      const app = db.getApp(link.app_id);
      if (!app) continue;

      const appEnv = JSON.parse(app.env_vars || "{}");
      const prefix = link.env_prefix || "DATABASE";

      if (replicas.length > 0) {
        const replicaUrls = replicas.map((r: any) => {
          const server = db.getServer(r.server_id);
          if (!server) return "";
          return buildConnectionUrl(catalog, envVars, server.ipv4, r.host_port);
        }).filter(Boolean);
        appEnv[`${prefix}_REPLICA_URLS`] = replicaUrls.join(",");
      } else {
        delete appEnv[`${prefix}_REPLICA_URLS`];
      }

      db.updateAppEnvVars(app.id, JSON.stringify(appEnv));
    } catch (err) {
      log("scale", `Failed to update linked app ${link.app_id}: ${err}`);
    }
  }
}
