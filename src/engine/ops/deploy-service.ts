import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import {
  sshExec,
  pullAndRunService,
  serviceHealthCheck,
  containerRunningCheck,
  getContainerLogs,
} from "../../shared/remote/index.ts";
import { provisionServer } from "../provision-server.ts";
import { replicaBindHost } from "../scale/types.ts";
import {
  syncAllTraefik,
  getPanelIngressIpv4,
} from "../scale/traefik-manager.ts";
import {
  getCatalogEntry,
  generateEnvVars,
  resolveServiceImage,
  resolveEnvVarTemplates,
  buildConnectionUrl,
  type ServiceDefinition,
} from "../../shared/services/catalog.ts";
import { parseEnvVars, serializeEnvVars, encryptValue } from "../../shared/env-crypto.ts";
import type { EnvVarEntry } from "../../shared/env-crypto.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import type { Server } from "../../shared/rpc.ts";
import { createMasker } from "../../shared/mask.ts";

// Public request shape for the `deploy_service` engine op — consumed by the
// HTTP route that enqueues the op and by the op implementation itself.
export type ServiceDeployRequest = {
  name: string;
  service_type: string;
  version?: string;
  volume_size?: number;
  env_overrides?: Record<string, string>;
  environment_id?: number;
  env_prefix?: string;
  /** Optional custom domain for HTTP-facing services; falls back to nip.io. */
  domain?: string;
};

type DeployServiceInput = ServiceDeployRequest;

type ServerOut = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
  provisioned: boolean;
  providerServerId?: string;
  /** Panel ipv4 used for HTTP service ingress; falls back to serverIp on single-server setups. */
  ingressIp: string;
};

type VolumeOut = {
  volumeId: string;
  volumeMount: string;
  hostMountPath: string;
  containerPath: string;
  volumeSize: number;
  skipped: boolean;
};

export function serviceVolumeName(serviceName: string, opId: number): string {
  return `ocd-svc-${serviceName}-op${opId}`;
}

export function assertAdoptableServiceVolume(
  volume: { providerId: string; sizeGb: number; location: string; serverId: string | null },
  expected: { sizeGb: number; location: string; serverId: string },
  retired: { provider_volume_id: string; former_resource_type: string; former_resource_name: string }[],
): void {
  const retiredRow = retired.find((row) => row.provider_volume_id === volume.providerId);
  if (retiredRow) {
    throw new Error(
      `Refusing to adopt retained volume ${volume.providerId}; it belongs to ` +
      `${retiredRow.former_resource_type}:${retiredRow.former_resource_name}.`,
    );
  }
  if (
    volume.sizeGb !== expected.sizeGb ||
    volume.location !== expected.location ||
    (volume.serverId != null && volume.serverId !== expected.serverId)
  ) {
    throw new Error(
      `Provider volume ${volume.providerId} does not match the requested size/location/server. ` +
      "Refusing implicit adoption.",
    );
  }
}

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
    if (db.getServiceByName(req.name)) {
      throw new Error(`A service named "${req.name}" already exists`);
    }
    if (db.getAppByName(req.name)) {
      throw new Error(`An app named "${req.name}" already exists. Choose a different name.`);
    }
    const catalog = resolveCatalog(req);

    // HTTP services need a panel for ingress — fail early with a clear message
    // rather than provisioning a server we'll have to throw away.
    let ingressIp: string | null = null;
    if (catalog.http) {
      ingressIp = getPanelIngressIpv4();
      if (!ingressIp) {
        throw new Error(
          `HTTP service "${catalog.label}" requires a panel server. Deploy the panel first, then try again.`,
        );
      }
    }

    const panelServerId = db.getPanel()?.server_id;
    const existingReady = db.getServers().find((s) =>
      s.status === "ready" && s.id !== panelServerId && s.pool === "general"
    );
    if (existingReady) {
      return {
        serverId: existingReady.id,
        serverIp: existingReady.ipv4,
        serverHostKey: existingReady.ssh_host_key || "",
        provisioned: false,
        ingressIp: ingressIp || existingReady.ipv4,
      };
    }
    const settings = db.getSettings();
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
      ingressIp: ingressIp || newServer.ipv4,
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
  async probe(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const catalog = resolveCatalog(req);
    if (!catalog.volumePath) {
      return {
        volumeId: "", volumeMount: "", hostMountPath: "", containerPath: "",
        volumeSize: 0, skipped: true,
      };
    }
    const volumeSize = req.volume_size || catalog.defaultVolumeSize;
    let providerServerId = server.providerServerId;
    const serverRow = db.getServer(server.serverId);
    if (!providerServerId) providerServerId = serverRow?.provider_id;
    if (!providerServerId || !serverRow) return null;
    const name = serviceVolumeName(req.name, ctx.opId);
    let volumes;
    try {
      volumes = await hetzner.volumes.list();
    } catch {
      return null;
    }
    const existing = volumes.find((volume) => volume.name === name);
    if (!existing) return null;
    assertAdoptableServiceVolume(existing, {
      sizeGb: volumeSize,
      location: serverRow.location || "nbg1",
      serverId: providerServerId,
    }, db.getRetiredVolumes());
    const hostMountPath = `/mnt/${name}`;
    ctx.log(`Adopting verified operation-owned volume ${existing.providerId} (${name})`);
    return {
      volumeId: existing.providerId,
      volumeMount: `${hostMountPath}:${catalog.volumePath}`,
      hostMountPath,
      containerPath: catalog.volumePath,
      volumeSize,
      skipped: false,
    };
  },
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const catalog = resolveCatalog(req);
    // Stateless services (no volumePath) skip provisioning.
    if (!catalog.volumePath) {
      ctx.log("Stateless service — skipping volume");
      return {
        volumeId: "",
        volumeMount: "",
        hostMountPath: "",
        containerPath: "",
        volumeSize: 0,
        skipped: true,
      };
    }
    const volumeSize = req.volume_size || catalog.defaultVolumeSize;

    const compute = hetzner;
    if (!compute.volumes) {
      throw new Error(`Provider "${compute.name}" does not support managed volumes`);
    }

    let providerServerId = server.providerServerId;
    if (!providerServerId) {
      const existing = db.getServer(server.serverId);
      if (!existing) throw new Error(`Server ${server.serverId} not found`);
      providerServerId = existing.provider_id;
    }
    const serverLocation = db.getServer(server.serverId)?.location || "nbg1";
    const name = serviceVolumeName(req.name, ctx.opId);
    const vol = await compute.volumes.create({
      name,
      sizeGb: volumeSize,
      serverId: providerServerId,
      location: serverLocation,
    });
    // Hetzner volumes need a moment before the mount appears.
    await Bun.sleep(3000);
    const hostMountPath = `/mnt/${name}`;
    const containerPath = catalog.volumePath;
    ctx.log(`Volume ready (${volumeSize}GB)`);
    return {
      volumeId: vol.providerId,
      volumeMount: containerPath ? `${hostMountPath}:${containerPath}` : "",
      hostMountPath,
      containerPath,
      volumeSize,
      skipped: false,
    };
  },
  async compensate(ctx, out) {
    if (!out || out.skipped) return;
    const compute = hetzner;
    // Stateful service data gets a seven-day recovery window. Compensation
    // detaches and records the volume rather than immediately deleting it.
    try { await compute.volumes?.detach(out.volumeId); } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    db.retireVolume({
      providerVolumeId: out.volumeId,
      formerResourceType: "service",
      formerResourceId: 0,
      formerResourceName: ctx.input.name,
      reason: `deployment operation #${ctx.opId} compensated`,
      retentionClass: "provisional",
    });
    ctx.log(`Retained detached volume ${out.volumeId} for recovery until its purge-after date`);
  },
  async probeCompensated(_ctx, out) {
    if (!out || out.skipped) return true;
    return db.getRetiredVolumes().some((row) => row.provider_volume_id === out.volumeId);
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
    const image = resolveServiceImage(catalog, version);

    const hostPort = db.nextServiceHostPort(server.serverId);
    const containerName = req.name;

    const serverRow = db.getServer(server.serverId);
    if (!serverRow) throw new Error(`Server ${server.serverId} not found`);
    // All services bind on the private network — DB-protocol clients reach
    // them directly across the fleet, HTTP services are proxied by the
    // panel's ingress proxy via the same address.
    const bindAddress = replicaBindHost(serverRow);
    // Credentials advertise the stable /etc/hosts alias, not the raw private
    // IP — the alias survives service migrations across servers, while
    // bindAddress remains what docker run/health checks actually bind to.
    const stableHost = `${req.name}.svc.ocd.internal`;
    const generated = resolveEnvVarTemplates(generateEnvVars(catalog, version), {
      host: stableHost,
      port: hostPort,
      internalHost: containerName,
      internalPort: catalog.defaultPort,
    });
    // Explicit user/manifest overrides remain literal and take precedence over
    // catalog defaults (including defaults containing runtime placeholders).
    const envVars = { ...generated, ...(req.env_overrides || {}) };

    let connectionUrl: string;
    let httpDomain: string | undefined;
    if (catalog.http) {
      // HTTP ingress lives on the panel server, so the public hostname must
      // resolve to the panel's IP, not the service server's. The nip.io
      // fallback uses the panel ipv4 captured in pick_or_provision_server.
      httpDomain = req.domain || `${req.name}.${server.ingressIp}.nip.io`;
      connectionUrl = `https://${httpDomain}`;
    } else {
      connectionUrl = buildConnectionUrl(catalog, envVars, stableHost, hostPort);
    }
    const credentials: Record<string, string | number> = {
      host: stableHost,
      port: hostPort,
      internal_host: containerName,
      internal_port: catalog.defaultPort,
      ...extractCredentialFields(catalog, envVars),
      connection_url: connectionUrl,
    };
    if (httpDomain) {
      credentials.url = `https://${httpDomain}`;
      credentials.domain = httpDomain;
    }

    const service = db.insertService({
      name: req.name,
      service_type: req.service_type,
      version,
      port: catalog.defaultPort,
      env_vars: JSON.stringify(envVars),
      credentials: JSON.stringify(credentials),
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
    // DB teardown of the half-registered service. Deleting an already-gone row
    // is a no-op (so retry is safe); let a genuine failure PROPAGATE rather
    // than orphan the service/instance rows behind a clean `compensated`.
    db.deleteServiceInstance(out.instanceId);
    db.deleteService(out.serviceId);
  },
};

const setupVolumeBindMount: Step<DeployServiceInput, { ok: true }> = {
  name: "setup_volume_bind_mount",
  label: "Bind volume mount",
  async run(ctx, prior) {
    const volume = prior["create_volume"] as VolumeOut;
    if (!volume || volume.skipped) return { ok: true };
    const server = prior["pick_or_provision_server"] as ServerOut;
    const svc = prior["insert_service_and_instance"] as InsertOut;
    const { ensureVolumeBindMount } = await import("../hetzner/host-mounts.ts");
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await ensureVolumeBindMount({
          serverIp: server.serverIp,
          hostKey: server.serverHostKey || undefined,
          hetznerVolumeId: volume.volumeId,
          hostMountPath: volume.hostMountPath,
          blockName: `svc-${svc.serviceId}`,
        });
        ctx.log(`Bind mount ready: ${volume.hostMountPath} -> /mnt/HC_Volume_${volume.volumeId}`);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        await Bun.sleep(3000);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  },
  async compensate(ctx, _out, prior) {
    const volume = prior["create_volume"] as VolumeOut | undefined;
    if (!volume || volume.skipped) return;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    const svc = prior["insert_service_and_instance"] as InsertOut | undefined;
    if (!server || !svc) return;
    try {
      const { removeVolumeBindMount } = await import("../hetzner/host-mounts.ts");
      await removeVolumeBindMount({
        serverIp: server.serverIp,
        hostKey: server.serverHostKey || undefined,
        hostMountPath: volume.hostMountPath,
        blockName: `svc-${svc.serviceId}`,
      });
    } catch (err) {
      ctx.log(`Failed to remove bind mount: ${err}`);
    }
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
        volumeMount: volume.skipped ? undefined : volume.volumeMount,
        bindAddress: svc.bindAddress,
        cmd: catalog.cmd,
        memoryMb: catalog.memoryMb,
        cpus: catalog.cpus,
        extraCaps: catalog.extraCaps,
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
      const mask = createMasker(Object.values(svc.envVars));
      const logs = await getContainerLogs(
        server.serverIp,
        svc.containerName,
        200,
        server.serverHostKey || undefined,
      );
      for (const rawLine of logs.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        ctx.log(mask(`[failed-container] ${rawLine}`));
      }
    } catch (err) {
      ctx.log(`Could not capture failed container logs: ${err}`);
    }
    // `docker rm -f ... || true` tolerates an already-removed container
    // (idempotent), so the remote command exits 0 for docker's own errors. A
    // nonzero exit here is therefore an SSH transport failure — i.e. we could
    // NOT reach the host to remove the container. Surface that as
    // `compensation_failed` instead of leaving the container leaked behind a
    // clean `compensated`.
    const r = await sshExec(
      server.serverIp,
      `su - deploy -c "docker rm -f ${svc.containerName} 2>/dev/null || true"`,
      server.serverHostKey || undefined,
    );
    if (r.exitCode !== 0) {
      throw new Error(`Could not reach ${server.serverIp} over SSH to remove container ${svc.containerName} (ssh exit ${r.exitCode})`);
    }
  },
};

const configureHttpIngress: Step<DeployServiceInput, { ok: true; domain?: string }> = {
  name: "configure_http_ingress",
  label: "Configure ingress",
  async run(ctx, prior) {
    const req = ctx.input;
    const catalog = resolveCatalog(req);
    if (!catalog.http) return { ok: true };
    const server = prior["pick_or_provision_server"] as ServerOut;
    const svc = prior["insert_service_and_instance"] as InsertOut;
    const domain = String(svc.credentials.domain || "");
    if (!domain) return { ok: true };

    const serverRow = db.getServer(server.serverId);
    const privateIp = serverRow?.private_ipv4 || "";

    // Preconditions for routing an HTTP service's public vhost through the
    // panel: a registered panel to own the ingress IP, and a private IP on the
    // service's host so the panel can reach it over the shared network.
    if (!db.getPanel()) {
      throw new Error(
        "No panel server is registered; HTTP services need a panel to route ingress through. Deploy the panel first.",
      );
    }
    if (!privateIp) {
      throw new Error(
        "Service server has no private IP — HTTP services require the shared private network. Wait for the network reconciler to attach the server and retry.",
      );
    }
    await syncAllTraefik();
    ctx.log(`Ingress configured: https://${domain}`);
    return { ok: true, domain };
  },
  async compensate(ctx, _out, prior) {
    const svc = prior["insert_service_and_instance"] as InsertOut | undefined;
    if (!svc) return;
    try {
      await syncAllTraefik();
    } catch (err) {
      ctx.log(`Failed to remove ingress route: ${err}`);
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

    const envRow = db.getEnvironment(req.environment_id);
    if (envRow) {
      const parsed = parseEnvVars(envRow.env_vars);
      const newKeys = new Set(newEntries.map((e) => e.key));
      const filtered = parsed.entries.filter((e) => !newKeys.has(e.key));
      db.updateEnvironment(req.environment_id, envRow.name, serializeEnvVars([...filtered, ...newEntries]));
      db.insertServiceLink(svc.serviceId, req.environment_id, envPrefix);
      const stale = db.markAppsEnvironmentStaleForKeys(
        req.environment_id,
        newEntries.map((entry) => entry.key),
      );
      ctx.log(`Credentials added to environment "${envRow.name}"`);
      if (stale > 0) ctx.log(`Marked ${stale} linked app(s) as stale environment`);
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

    let health = await serviceHealthCheck(
      server.serverIp,
      svc.containerName,
      catalog.healthCmd,
      10,
      server.serverHostKey || undefined,
    );
    if (health.healthy && catalog.postStartCmd) {
      const setup = await serviceHealthCheck(
        server.serverIp,
        svc.containerName,
        catalog.postStartCmd,
        1,
        server.serverHostKey || undefined,
      );
      if (!setup.healthy) {
        health = {
          healthy: false,
          error: `Post-start setup failed: ${setup.error || "command failed"}`,
        };
      } else {
        ctx.log("Post-start setup complete");
      }
    }
    if (health.healthy) {
      const stability = await containerRunningCheck(
        server.serverIp,
        svc.containerName,
        10,
        server.serverHostKey || undefined,
      );
      if (!stability.healthy) {
        health = {
          healthy: false,
          error: stability.error || "Container did not remain stable after startup",
        };
      }
    }
    if (health.healthy) {
      db.updateServiceInstanceStatus(svc.instanceId, "running");
      db.updateServiceStatus(svc.serviceId, "running");
      ctx.log("Service is healthy");
    } else {
      db.updateServiceInstanceStatus(svc.instanceId, "unhealthy");
      db.updateServiceStatus(svc.serviceId, "unhealthy");
      const error = health.error || "service did not become healthy";
      ctx.log(`Health check failed: ${error}`);
      throw new Error(error);
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
    setupVolumeBindMount,
    pullAndRunContainer,
    configureHttpIngress,
    injectCredentials,
    healthCheckStep,
  ],
};

registerOp(deployServiceOp as OpKindDefinition<any>);

export default deployServiceOp;
export type { DeployServiceInput };
