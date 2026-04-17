import * as db from "../../shared/db.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";
import { sshExec, pullAndRunService, serviceHealthCheck } from "../../shared/remote/index.ts";
import { provisionServer } from "../provision-server.ts";
import { replicaBindHost } from "../scale/types.ts";
import {
  getCatalogEntry,
  generateEnvVars,
  buildConnectionUrl,
  type ServiceDefinition,
} from "../../shared/services/catalog.ts";
import { parseEnvVars, serializeEnvVars, encryptValue } from "../../shared/env-crypto.ts";
import type { EnvVarEntry } from "../../shared/env-crypto.ts";
import type { ServiceDeployRequest } from "../deploy/deploy-service.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import type { Server } from "../../shared/rpc.ts";

type DeployServiceInput = ServiceDeployRequest;

type ServerOut = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
  provisioned: boolean;
  providerServerId?: string;
};

type VolumeOut = {
  volumeId: string;
  volumeMount: string;
  hostMountPath: string;
  containerPath: string;
  volumeSize: number;
};

type InsertOut = {
  serviceId: number;
  instanceId: number;
  containerName: string;
  hostPort: number;
  bindAddress: string;
  version: string;
  image: string;
  envVars: Record<string, string>;
  credentials: Record<string, string | number>;
};

function resolveCatalog(input: DeployServiceInput): ServiceDefinition {
  const catalog = getCatalogEntry(input.service_type);
  if (!catalog) throw new Error(`Unknown service type: ${input.service_type}`);
  return catalog;
}

function extractCredentialFields(
  catalog: ServiceDefinition,
  envVars: Record<string, string>,
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

// --- Steps ---------------------------------------------------------------

const pickOrProvisionServer: Step<DeployServiceInput, ServerOut> = {
  name: "pick_or_provision_server",
  label: "Pick server",
  async run(ctx) {
    const req = ctx.input;
    // Pre-flight validations (name + duplicates).
    if (!req.name || !/^[a-z0-9][a-z0-9-]*$/.test(req.name)) {
      throw new Error("Service name must start with a letter/digit and contain only lowercase letters, digits, and hyphens");
    }
    if (db.getServiceByName(req.name, ctx.orgId)) {
      throw new Error(`A service named "${req.name}" already exists`);
    }
    if (db.getAppByName(req.name, ctx.orgId)) {
      throw new Error(`An app named "${req.name}" already exists. Choose a different name.`);
    }
    resolveCatalog(req);

    const existingReady = db.getServers(ctx.orgId).find((s: Server) => s.status === "ready");
    if (existingReady) {
      return {
        serverId: existingReady.id,
        serverIp: existingReady.ipv4,
        serverHostKey: existingReady.ssh_host_key || "",
        provisioned: false,
      };
    }
    const settings = db.getOrgSettings(ctx.orgId);
    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    const location = settings.default_location;
    if (!location) throw new Error("No default server location configured — set one in Settings");

    const newServer = await provisionServer({
      serverType,
      location,
      name: `ocd-svc-${req.name}-${Date.now()}`,
      emit: (step, detail) => ctx.log(`[${step}] ${detail}`),
    });
    return {
      serverId: newServer.id,
      serverIp: newServer.ipv4,
      serverHostKey: newServer.ssh_host_key || "",
      provisioned: true,
      providerServerId: newServer.provider_id,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try { await db.gcServerIfEmpty(out.serverId); }
    catch (err) { ctx.log(`gcServerIfEmpty(${out.serverId}) failed: ${err}`); }
  },
};

const createVolume: Step<DeployServiceInput, VolumeOut> = {
  name: "create_volume",
  label: "Create volume",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const catalog = resolveCatalog(req);
    const volumeSize = req.volume_size || catalog.defaultVolumeSize;

    const compute = getComputeProvider();
    if (!compute.volumes) {
      throw new Error(`Provider "${compute.name}" does not support managed volumes`);
    }

    let providerServerId = server.providerServerId;
    if (!providerServerId) {
      const existing = db.getServerUnscoped(server.serverId);
      if (!existing) throw new Error(`Server ${server.serverId} not found`);
      providerServerId = existing.provider_id;
    }
    const serverLocation = db.getServerUnscoped(server.serverId)?.location || "nbg1";
    const vol = await compute.volumes.create({
      name: `ocd-svc-${req.name}-data`,
      sizeGb: volumeSize,
      serverId: providerServerId,
      location: serverLocation,
    });
    // Hetzner volumes need a moment before the mount appears.
    await Bun.sleep(3000);
    const hostMountPath = `/mnt/ocd-svc-${req.name}-data`;
    const containerPath = catalog.volumePath;
    ctx.log(`Volume ready (${volumeSize}GB)`);
    return {
      volumeId: vol.providerId,
      volumeMount: `${hostMountPath}:${containerPath}`,
      hostMountPath,
      containerPath,
      volumeSize,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try {
      const compute = getComputeProvider();
      try { await compute.volumes?.detach(out.volumeId); } catch { /* already detached */ }
      await compute.volumes?.delete(out.volumeId);
    } catch (err) {
      ctx.log(`Failed to delete volume ${out.volumeId}: ${err}`);
    }
  },
};

const insertServiceAndInstance: Step<DeployServiceInput, InsertOut> = {
  name: "insert_service_and_instance",
  label: "Register service",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const volume = prior["create_volume"] as VolumeOut;
    const catalog = resolveCatalog(req);
    const version = req.version || catalog.versions[0];
    const image = `${catalog.image}:${version}`;

    const generated = generateEnvVars(catalog);
    const envVars = { ...generated, ...(req.env_overrides || {}) };

    const hostPort = db.nextServiceHostPort(server.serverId);
    const containerName = req.name;

    const serverRow = db.getServerUnscoped(server.serverId);
    if (!serverRow) throw new Error(`Server ${server.serverId} not found`);
    const bindAddress = replicaBindHost(serverRow);

    const connectionUrl = buildConnectionUrl(catalog, envVars, bindAddress, hostPort);
    const credentials: Record<string, string | number> = {
      host: bindAddress,
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
      org_id: ctx.orgId,
    });
    const instance = db.insertServiceInstance({
      service_id: service.id,
      server_id: server.serverId,
      role: "primary",
      container_name: containerName,
      host_port: hostPort,
      volume_id: volume.volumeId,
      volume_mount: volume.volumeMount,
    });

    return {
      serviceId: service.id,
      instanceId: instance.id,
      containerName,
      hostPort,
      bindAddress,
      version,
      image,
      envVars,
      credentials,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try { db.deleteServiceInstance(out.instanceId); }
    catch (err) { ctx.log(`Failed to delete service instance: ${err}`); }
    try { db.deleteService(out.serviceId); }
    catch (err) { ctx.log(`Failed to delete service row: ${err}`); }
  },
};

const pullAndRunContainer: Step<DeployServiceInput, { ok: true }> = {
  name: "pull_and_run_container",
  label: "Pull and run container",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const volume = prior["create_volume"] as VolumeOut;
    const svc = prior["insert_service_and_instance"] as InsertOut;
    const catalog = resolveCatalog(req);

    await pullAndRunService(
      server.serverIp,
      {
        name: svc.containerName,
        image: svc.image,
        port: catalog.defaultPort,
        hostPort: svc.hostPort,
        envVars: svc.envVars,
        volumeMount: volume.volumeMount,
        bindAddress: svc.bindAddress,
      },
      server.serverHostKey || undefined,
    );
    ctx.log("Container started");
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    const svc = prior["insert_service_and_instance"] as InsertOut | undefined;
    if (!server || !svc) return;
    try {
      await sshExec(
        server.serverIp,
        `su - deploy -c "docker rm -f ${svc.containerName} 2>/dev/null || true"`,
        server.serverHostKey || undefined,
      );
    } catch (err) {
      ctx.log(`Failed to remove container ${svc.containerName}: ${err}`);
    }
  },
};

const injectCredentials: Step<DeployServiceInput, { ok: true; injected: boolean }> = {
  name: "inject_env_credentials",
  label: "Inject credentials",
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.environment_id) return { ok: true, injected: false };
    const svc = prior["insert_service_and_instance"] as InsertOut;
    const credentials = svc.credentials;

    const envPrefix = req.env_prefix || "DATABASE";
    const now = new Date().toISOString();
    const secretKeys = new Set([`${envPrefix}_URL`, `${envPrefix}_PASSWORD`]);
    const pairs: [string, string][] = [
      [`${envPrefix}_URL`, String(credentials.connection_url || "")],
      [`${envPrefix}_HOST`, String(credentials.host || "")],
      [`${envPrefix}_PORT`, String(credentials.port || "")],
    ];
    if (credentials.username) pairs.push([`${envPrefix}_USER`, String(credentials.username)]);
    if (credentials.password) pairs.push([`${envPrefix}_PASSWORD`, String(credentials.password)]);
    if (credentials.database) pairs.push([`${envPrefix}_NAME`, String(credentials.database)]);

    const newEntries: EnvVarEntry[] = [];
    for (const [key, value] of pairs) {
      const isSecret = secretKeys.has(key);
      if (isSecret) {
        const { encrypted_value, iv } = await encryptValue(value);
        newEntries.push({ key, value: "", encrypted_value, iv, secret: true, updated_at: now });
      } else {
        newEntries.push({ key, value, secret: false, updated_at: now });
      }
    }

    const envRow = db.getEnvironmentUnscoped(req.environment_id);
    if (envRow) {
      const parsed = parseEnvVars(envRow.env_vars);
      const newKeys = new Set(newEntries.map((e) => e.key));
      const filtered = parsed.entries.filter((e) => !newKeys.has(e.key));
      db.updateEnvironment(req.environment_id, envRow.name, serializeEnvVars([...filtered, ...newEntries]));
      ctx.log(`Credentials added to environment "${envRow.name}"`);
    }
    return { ok: true, injected: true };
  },
};

const healthCheckStep: Step<DeployServiceInput, { healthy: boolean }> = {
  name: "health_check",
  label: "Health check",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const svc = prior["insert_service_and_instance"] as InsertOut;
    const catalog = resolveCatalog(req);

    const health = await serviceHealthCheck(
      server.serverIp,
      svc.containerName,
      catalog.healthCmd,
      10,
      server.serverHostKey || undefined,
    );
    if (health.healthy) {
      db.updateServiceInstanceStatus(svc.instanceId, "running");
      db.updateServiceStatus(svc.serviceId, "running");
      ctx.log("Service is healthy");
    } else {
      // Soft-fail: persist warning but do not throw.
      db.updateServiceInstanceStatus(svc.instanceId, "unhealthy");
      db.updateServiceStatus(svc.serviceId, "unhealthy");
      ctx.log(`Health check warning: ${health.error || "service may still be starting"}`);
    }
    return { healthy: health.healthy };
  },
};

const deployServiceOp: OpKindDefinition<DeployServiceInput> = {
  kind: "deploy_service",
  label: "Deploy service",
  resourceKeys: (input) => [`service:create:${input.name}`],
  steps: [
    pickOrProvisionServer,
    createVolume,
    insertServiceAndInstance,
    pullAndRunContainer,
    injectCredentials,
    healthCheckStep,
  ],
};

registerOp(deployServiceOp);

export default deployServiceOp;
export type { DeployServiceInput };
