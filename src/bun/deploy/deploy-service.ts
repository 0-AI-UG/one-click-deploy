import type { Server } from "../../shared/rpc.ts";
import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { getTokens } from "../secret-store.ts";
import { createMasker } from "../mask.ts";
import {
  getCatalogEntry,
  generateEnvVars,
  buildConnectionUrl,
  type ServiceDefinition,
} from "../services/catalog.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy-service:${context}]`, ...args);
}

export type ServiceDeployRequest = {
  name: string;
  service_type: string;
  version?: string;
  volume_size?: number;
  env_overrides?: Record<string, string>;
};

type DeployState = {
  hetznerServerId?: string;
  dbServerId?: number;
  serviceId?: number;
  instanceId?: number;
  volumeId?: string;
  containerName?: string;
};

async function rollback(state: DeployState, serverIp: string, hostKey?: string): Promise<void> {
  log("rollback", "Rolling back service deploy state:", state);

  if (state.containerName && serverIp) {
    try {
      await hetzner.sshExec(
        serverIp,
        `su - deploy -c "docker rm -f ${state.containerName} 2>/dev/null || true"`,
        hostKey
      );
      log("rollback", `Removed container ${state.containerName}`);
    } catch (err) {
      log("rollback", `Failed to remove container: ${err}`);
    }
  }

  if (state.volumeId) {
    try {
      await hetzner.deleteVolume(state.volumeId);
      log("rollback", `Deleted volume ${state.volumeId}`);
    } catch (err) {
      log("rollback", `Failed to delete volume: ${err}`);
    }
  }

  if (state.instanceId) {
    try {
      db.deleteServiceInstance(state.instanceId);
    } catch (err) {
      log("rollback", `Failed to delete instance record: ${err}`);
    }
  }

  if (state.serviceId) {
    try {
      db.deleteService(state.serviceId);
      log("rollback", `Deleted service record ${state.serviceId}`);
    } catch (err) {
      log("rollback", `Failed to delete service record: ${err}`);
    }
  }

  if (state.dbServerId) {
    try {
      await db.gcServerIfEmpty(state.dbServerId);
    } catch (err) {
      log("rollback", `gcServerIfEmpty(${state.dbServerId}) failed: ${err}`);
    }
  }

  log("rollback", "Rollback complete");
}

export async function deployService(
  req: ServiceDeployRequest,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string; serviceId?: number }> {
  const deployStart = Date.now();
  log("start", "Service deploy request:", req);

  // Validate service type
  const catalog = getCatalogEntry(req.service_type);
  if (!catalog) {
    return { ok: false, error: `Unknown service type: ${req.service_type}` };
  }

  // Validate name
  if (!req.name || !/^[a-z0-9][a-z0-9-]*$/.test(req.name)) {
    return { ok: false, error: "Service name must start with a letter/digit and contain only lowercase letters, digits, and hyphens" };
  }

  // Check duplicate name
  if (db.getServiceByName(req.name)) {
    return { ok: false, error: `A service named "${req.name}" already exists` };
  }
  // Also check against app names since they share the Docker namespace
  if (db.getAppByName(req.name)) {
    return { ok: false, error: `An app named "${req.name}" already exists. Choose a different name.` };
  }

  const version = req.version || catalog.versions[0];
  const image = `${catalog.image}:${version}`;

  // Generate env vars with credentials
  const generatedEnv = generateEnvVars(catalog);
  const envVars = { ...generatedEnv, ...(req.env_overrides || {}) };

  // Mask secrets in logs
  const tokens = await getTokens();
  const secretValues = [tokens.hetzner_api_token, ...Object.values(envVars)];
  const mask = createMasker(secretValues);

  const state: DeployState = {};
  let serverIp = "";
  let serverHostKey = "";

  try {
    const settings = db.getSettings();
    let serverId: number;

    // Step 1: Select server
    onProgress("server", "Selecting server...");
    const existingReady = db.getServers().find((s: Server) => s.status === "ready");
    if (existingReady) {
      serverIp = existingReady.ipv4;
      serverHostKey = existingReady.ssh_host_key || "";
      serverId = existingReady.id;
      state.dbServerId = existingReady.id;
      log("server", `Reusing existing ready server: ${existingReady.name} ip=${serverIp}`);
      onProgress("server", `Using server ${existingReady.name} (${serverIp})`);
    } else {
      onProgress("server", "Creating new Hetzner server...");

      const [sshKey, firewallId] = await Promise.all([
        hetzner.ensureSshKey("one-click-deploy"),
        hetzner.ensureFirewall(),
      ]);
      onProgress("server", "SSH key + firewall ready");

      const serverType = settings.default_server_type;
      if (!serverType) throw new Error("No default server type configured — set one in Settings");
      const location = settings.default_location;
      if (!location) throw new Error("No default server location configured — set one in Settings");
      const serverName = `ocd-svc-${req.name}-${Date.now()}`;

      const dbServer = db.insertServer({
        name: serverName,
        hetzner_id: "",
        ipv4: "",
        ipv6: "",
        type: serverType,
        location,
        status: "creating",
      });
      serverId = dbServer.id;
      state.dbServerId = dbServer.id;

      const hServer = await hetzner.createServer({
        name: serverName,
        server_type: serverType,
        location,
        ssh_key_name: sshKey.name,
        firewall_id: firewallId,
      });
      state.hetznerServerId = String(hServer.id);

      serverIp = hServer.public_net.ipv4.ip;
      db.updateServer(dbServer.id, {
        hetzner_id: String(hServer.id),
        ipv4: serverIp,
        ipv6: hServer.public_net.ipv6.ip || "",
        status: "provisioning",
      });
      onProgress("server", `Server created: ${serverName} (${serverIp})`);

      await hetzner.waitForServerRunning(hServer.id, (msg) => onProgress("provision", msg));

      onProgress("provision", "Waiting for server to be ready...");
      await hetzner.waitForServer(serverIp, 30, (msg) => onProgress("provision", msg));

      const dockerCheck = await hetzner.sshExec(serverIp, "docker --version");
      if (dockerCheck.exitCode !== 0) {
        throw new Error("Server provisioned but Docker was not installed");
      }

      serverHostKey = await hetzner.captureHostKey(serverIp);
      if (serverHostKey) {
        db.updateServerHostKey(dbServer.id, serverHostKey);
      }

      db.updateServerStatus(dbServer.id, "ready");
      onProgress("provision", "Server provisioned with Docker");
    }

    // Step 2: Create volume
    const volumeSize = req.volume_size || catalog.defaultVolumeSize;
    onProgress("volume", `Creating ${volumeSize}GB persistent volume...`);

    let hetznerServerId: number;
    if (state.hetznerServerId) {
      hetznerServerId = parseInt(state.hetznerServerId, 10);
    } else {
      const srv = db.getServer(serverId);
      if (!srv) throw new Error(`Server ${serverId} not found`);
      hetznerServerId = parseInt(srv.hetzner_id, 10);
    }

    const serverLocation = db.getServer(serverId)?.location || "nbg1";
    const vol = await hetzner.createVolume({
      name: `ocd-svc-${req.name}-data`,
      size: volumeSize,
      server_id: hetznerServerId,
      location: serverLocation,
    });
    state.volumeId = String(vol.id);
    log("volume", `Volume created: ${vol.id} (${volumeSize}GB)`);
    onProgress("volume", `Volume created (${volumeSize}GB)`);

    // Wait for volume mount
    await Bun.sleep(3000);
    const hostMountPath = `/mnt/ocd-svc-${req.name}-data`;
    const volumeMount = `${hostMountPath}:${catalog.volumePath}`;

    // Step 3: Insert service + primary instance
    onProgress("service", "Creating service record...");
    const hostPort = db.nextServiceHostPort(serverId);
    const containerName = req.name;

    const connectionUrl = buildConnectionUrl(catalog, envVars, serverIp, hostPort);
    const credentials = {
      host: serverIp,
      port: hostPort,
      internal_host: containerName,
      internal_port: catalog.defaultPort,
      ...extractCredentialFields(catalog, envVars),
      connection_url: connectionUrl,
    };

    const service = db.insertService({
      name: req.name,
      service_type: req.service_type,
      version,
      port: catalog.defaultPort,
      env_vars: JSON.stringify(envVars),
      credentials: JSON.stringify(credentials),
    });
    state.serviceId = service.id;

    const instance = db.insertServiceInstance({
      service_id: service.id,
      server_id: serverId,
      role: "primary",
      container_name: containerName,
      host_port: hostPort,
      volume_id: String(vol.id),
      volume_mount: volumeMount,
    });
    state.instanceId = instance.id;
    state.containerName = containerName;

    // Step 4: Pull image and run container
    onProgress("deploy", `Pulling ${image}...`);

    // Determine if we need replication-ready config for primary
    const primaryExtraCmd = catalog.replication.supported
      ? catalog.replication.primaryExtraCmd
      : undefined;

    await hetzner.pullAndRunService(
      serverIp,
      {
        name: containerName,
        image,
        port: catalog.defaultPort,
        hostPort,
        envVars,
        volumeMount,
        cmd: primaryExtraCmd,
      },
      serverHostKey || undefined
    );
    onProgress("deploy", "Container started");

    // Step 5: Health check
    onProgress("health", "Checking service health...");
    const health = await hetzner.serviceHealthCheck(
      serverIp,
      containerName,
      catalog.healthCmd,
      10,
      serverHostKey || undefined
    );

    if (health.healthy) {
      db.updateServiceInstanceStatus(instance.id, "running");
      db.updateServiceStatus(service.id, "running");
      onProgress("health", "Service is healthy");
    } else {
      db.updateServiceInstanceStatus(instance.id, "unhealthy");
      db.updateServiceStatus(service.id, "unhealthy");
      onProgress("health", `Health check warning: ${health.error || "service may still be starting"}`);
    }

    const elapsed = ((Date.now() - deployStart) / 1000).toFixed(1);
    log("done", `Service ${req.name} deployed in ${elapsed}s`);
    onProgress("done", `Service deployed in ${elapsed}s`);

    return { ok: true, serviceId: service.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `Service deploy failed: ${mask(msg)}`);
    await rollback(state, serverIp, serverHostKey || undefined);
    return { ok: false, error: msg };
  }
}

/** Extract user/password/database fields from env vars based on catalog type */
function extractCredentialFields(
  catalog: ServiceDefinition,
  envVars: Record<string, string>
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const v of catalog.requiredEnvVars) {
    if (v.generate === "username" || v.label.toLowerCase().includes("username")) {
      fields.username = envVars[v.key] || "";
    } else if (v.generate === "password" || v.label.toLowerCase().includes("password")) {
      if (!fields.password) fields.password = envVars[v.key] || "";
    } else if (v.label.toLowerCase().includes("database")) {
      fields.database = envVars[v.key] || "";
    }
  }
  return fields;
}
