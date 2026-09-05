import { resolveStorageBindings, prepareStorageBindings, saveAppStorage, appStorageEnv, deleteAppStorage } from "../../shared/object-storage.ts";
import type { DeployRequest, Server } from "../../shared/rpc.ts";
import dbInstance, * as db from "../../shared/db.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import {
  normalizeAppScaling,
  resolveDeployRequestEnvironmentIds,
} from "../../shared/app-config.ts";
import {
  sshExec,
  pullImmutableImageAndRun,
  removeContainer,
  healthCheck,
  containerRunningCheck,
  containerExists,
  containerRunning,
  probeAppHealth,
  getContainerLogs,
  runAppPostStartCommand,
} from "../../shared/remote/index.ts";
import { syncAppIngress, syncAllTraefik } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import { validateDeployRequest, assertSafeHostPath } from "../../shared/validate.ts";
import { createMasker } from "../../shared/mask.ts";
import { processIncomingEnvVars, serializeEnvVars, parseEnvVars, platformEnvVars, projectEnvVars } from "../../shared/env-crypto.ts";
import { getInfrastructureToken } from "../../shared/secret-store.ts";
import { defaultInfrastructureProvider } from "../../shared/infrastructure.ts";
import { provisionServer } from "../provision-server.ts";
import { registerOp } from "./registry.ts";
import { FatalProbeError, type OpContext, type OpKindDefinition, type Step } from "../types.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";
import { scaleUp } from "../scale/scale-up.ts";
import { commitManifestDeliverySource } from "../manifest-delivery-source.ts";
import {
  defaultStorageDriverForServer,
  requireStorageDriver,
  type StorageDriver,
} from "../storage/index.ts";

type DeployInput = DeployRequest;

type ServerOut = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
  provisioned: boolean;
  providerServerId?: string;
  ingressIp: string;
};

type VolumeOut = {
  volumeId: string;
  driverId: string;
  volumeMount: string;
  containerPath: string;
  attached: boolean;
  detachOnCompensate: boolean;
} | null;

type InsertAppOut = {
  appId: number;
  replicaId: number;
  containerName: string;
  hostPort: number;
  domain: string;
  useInternalTls: boolean;
  environmentId: number | null;
  flatEnvVars: Record<string, string>;
};

type ArtifactOut = {
  imageTag: string;
  imageDigest?: string;
  imageBytes?: number;
};

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:deploy:${context}]`, ...args);
}

async function findVolumeByName(driver: StorageDriver, server: NonNullable<ReturnType<typeof db.getServer>>, name: string) {
  try {
    const all = await driver.list(server);
    return all.find((v) => v.name === name) ?? null;
  } catch (error) {
    throw new FatalProbeError(
      `Cannot verify whether operation-owned volume ${name} already exists; refusing to create a possible duplicate`,
      { cause: error },
    );
  }
}

export function appVolumeName(appName: string, opId: number): string {
  return `ocd-${appName}-op${opId}`;
}

async function deploymentMasker(input: DeployInput, userId: string, additionalSecrets: string[] = []) {
  const provider = defaultInfrastructureProvider(db.getSettings());
  const providerToken = provider ? await getInfrastructureToken(provider.id) : "";
  const envVarValues = input.env_vars
    ? Array.isArray(input.env_vars)
      ? input.env_vars.map((e) => e.value)
      : Object.values(input.env_vars)
    : [];
  const secretValues = [
    providerToken,
    ...envVarValues,
    ...additionalSecrets,
  ];
  return { mask: createMasker(secretValues) };
}

/** Resolve where the app is reachable from outside. Private apps get no
 *  domain at all — no DNS record, no public route, internal ingress only.
 *  Public apps without an explicit domain get `<app>.<default suffix>` when
 *  configured; otherwise nip.io remains the zero-configuration fallback.
 *  In either case OCD only reports DNS instructions and never changes DNS. */
export function resolveAppDomain(
  req: { app_name: string; domain?: string; public?: boolean },
  settings: { default_domain_suffix?: string },
  ingressIp: string,
): { domain: string } {
  if (req.public === false) return { domain: "" };
  if (req.domain) return { domain: req.domain };
  const suffix = (settings.default_domain_suffix || "").replace(/^\.+|\.+$/g, "").toLowerCase();
  if (suffix) return { domain: `${req.app_name}.${suffix}` };
  return { domain: `${req.app_name}.${ingressIp}.nip.io` };
}

function domainSettings(_server: ServerOut): { default_domain_suffix?: string } {
  const settings = db.getSettings();
  return { default_domain_suffix: settings.default_domain_suffix };
}

// --- Steps ----------------------------------------------------------------

const pickOrProvisionServer: Step<DeployInput, ServerOut> = {
  name: "pick_or_provision_server",
  label: "Pick server",
  async run(ctx) {
    const req = ctx.input;
    // Pre-flight: reject duplicate app names up front.
    const existing = db.getAppByName(req.app_name);
    if (existing) {
      throw new Error(`An app named "${req.app_name}" already exists. Choose a different name.`);
    }
    const validation = validateDeployRequest(req);
    if (!validation.valid) throw new Error(validation.error);

    // Hard fleet cap: every app permanently owns one internal ingress port.
    if (db.countApps() >= db.INTERNAL_PORT_COUNT) {
      throw new Error(
        "Fleet limit of 200 apps reached (internal port block 20000-20199 is full). Destroy an app before deploying a new one.",
      );
    }

    // Reject unsafe volume host paths early so the user sees a clear error
    // rather than a deploy that fails deep inside docker run.
    for (const v of req.extra_volumes || []) {
      assertSafeHostPath(v.host_path, req.app_name);
    }

    const settings = db.getSettings();
    const panel = db.getPanel();
    const panelServerRow = panel ? db.getServer(panel.server_id) : null;

    if (req.server_id) {
      const target = db.getServer(req.server_id) as Server | null;
      if (!target || target.status !== "ready") {
        throw new Error("Target server not found or not ready");
      }
      const ingressIp = panelServerRow?.ipv4 || target.ipv4;
      return {
        serverId: target.id,
        serverIp: target.ipv4,
        serverHostKey: target.ssh_host_key || "",
        provisioned: false,
        ingressIp,
      };
    }
    const desiredPool = req.placement_pool || "general";
    const existingReady = db.getServers().find((s) =>
      s.status === "ready" &&
      s.id !== panel?.server_id &&
      s.pool === desiredPool
    );
    if (existingReady) {
      const ingressIp = panelServerRow?.ipv4 || existingReady.ipv4;
      return {
        serverId: existingReady.id,
        serverIp: existingReady.ipv4,
        serverHostKey: existingReady.ssh_host_key || "",
        provisioned: false,
        ingressIp,
      };
    }
    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    const location = settings.default_location;
    if (!location) throw new Error("No default server location configured — set one in Settings");

    const newServer = await provisionServer({
      serverType,
      location,
      name: `ocd-${req.app_name}-op${ctx.opId}`,
      pool: desiredPool,
      approved: req.server_provisioning_approved === true,
      emit: (step, detail) => ctx.log(`[${step}] ${detail}`),
    });
    const ingressIp = panelServerRow?.ipv4 || newServer.ipv4;
    return {
      serverId: newServer.id,
      serverIp: newServer.ipv4,
      serverHostKey: newServer.ssh_host_key || "",
      provisioned: true,
      providerServerId: newServer.provider_id,
      ingressIp,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try {
      await db.gcServerIfEmpty(out.serverId);
    } catch (err) {
      ctx.log(`gcServerIfEmpty(${out.serverId}) failed: ${err}`);
    }
  },
};

const createVolume: Step<DeployInput, VolumeOut> = {
  name: "create_volume",
  label: "Create volume",
  async probe(ctx, prior) {
    const req = ctx.input;
    if (!req.volume_size || req.volume_size <= 0) return null;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const serverRow = db.getServer(server.serverId);
    if (!serverRow) throw new FatalProbeError(`Server ${server.serverId} not found`);
    const driver = req.volume_driver
      ? requireStorageDriver(req.volume_driver)
      : defaultStorageDriverForServer(serverRow);
    if (!driver.supports(serverRow)) throw new FatalProbeError(`Storage driver ${driver.id} does not support server ${serverRow.name}`);
    const attachedServerId = driver.portable ? serverRow.provider_id : String(serverRow.id);
    if (req.volume_id) {
      const info = await driver.inspect(req.volume_id, serverRow).catch(() => null);
      if (!info || info.attachedServerId !== attachedServerId) return null;
      if (info.sizeGb > req.volume_size) {
        throw new FatalProbeError(`Cannot shrink volume ${req.volume_id} from ${info.sizeGb}GB to ${req.volume_size}GB`);
      }
      if (info.sizeGb < req.volume_size) return null;
      const containerPath = req.volume_path || "/data";
      return {
        volumeId: req.volume_id,
        driverId: driver.id,
        volumeMount: `${info.hostPath}:${containerPath}`,
        containerPath,
        attached: true,
        detachOnCompensate: false,
      };
    }
    const volName = appVolumeName(req.app_name, ctx.opId);
    const existing = await findVolumeByName(driver, serverRow, volName);
    if (!existing) return null;
    const retired = db.getRetiredVolumes().find(
      (row) => row.provider_volume_id === existing.id,
    );
    if (retired) {
      throw new FatalProbeError(
        `Refusing to adopt retained volume ${existing.id} (${volName}); it belongs to ` +
        `${retired.former_resource_type}:${retired.former_resource_name}.`,
      );
    }
    if (
      existing.sizeGb !== req.volume_size ||
      (existing.attachedServerId != null && existing.attachedServerId !== attachedServerId)
    ) {
      throw new FatalProbeError(
        `Volume name collision for ${volName}: storage volume ${existing.id} ` +
        "does not match requested size/location/server. Refusing implicit adoption.",
      );
    }
    const hostMountPath = `/mnt/${volName}`;
    const containerPath = req.volume_path || "/data";
    ctx.log(`adopting existing volume ${existing.id} (${volName})`);
    return {
      volumeId: existing.id,
      driverId: driver.id,
      volumeMount: `${existing.hostPath || hostMountPath}:${containerPath}`,
      containerPath,
      attached: false,
      detachOnCompensate: true,
    };
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    return db.getRetiredVolumes().some((row) => row.provider_volume_id === out.volumeId);
  },
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.volume_size || req.volume_size <= 0) return null;

    const server = prior["pick_or_provision_server"] as ServerOut;
    const volumeServer = db.getServer(server.serverId);
    if (!volumeServer) throw new Error(`Server ${server.serverId} not found`);
    const driver = req.volume_driver
      ? requireStorageDriver(req.volume_driver)
      : defaultStorageDriverForServer(volumeServer);
    if (!driver.supports(volumeServer)) throw new Error(`Storage driver ${driver.id} does not support server ${volumeServer.name}`);
    const attachedServerId = driver.portable ? volumeServer.provider_id : String(volumeServer.id);

    if (req.volume_id) {
      const info = await driver.inspect(req.volume_id, volumeServer);
      if (info.attachedServerId && info.attachedServerId !== attachedServerId) {
        throw new Error(`Cannot adopt volume ${req.volume_id}: it is attached to another server`);
      }
      if (info.sizeGb > req.volume_size) {
        throw new Error(`Cannot shrink volume ${req.volume_id} from ${info.sizeGb}GB to ${req.volume_size}GB`);
      }
      if (info.sizeGb > 0 && info.sizeGb < req.volume_size) await driver.resize(req.volume_id, req.volume_size, volumeServer);
      const wasDetached = !info.attachedServerId;
      if (wasDetached) await driver.attach(req.volume_id, volumeServer);
      const containerPath = req.volume_path || "/data";
      ctx.log(`Adopted volume ${req.volume_id} (${req.volume_size}GB at ${containerPath})`);
      return {
        volumeId: req.volume_id,
        driverId: driver.id,
        volumeMount: `${info.hostPath}:${containerPath}`,
        containerPath,
        attached: true,
        detachOnCompensate: wasDetached,
      };
    }

    const volName = appVolumeName(req.app_name, ctx.opId);
    const vol = await driver.create({
      server: volumeServer,
      name: volName,
      sizeGb: req.volume_size,
    });
    const hostMountPath = vol.hostPath;
    const containerPath = req.volume_path || "/data";
    // Host bind-mount setup happens in a later step (setup_volume_bind_mount)
    // once we have an app.id to tag the fstab block with.
    ctx.log(`Volume ready (${req.volume_size}GB at ${containerPath})`);
    return {
      volumeId: vol.id,
      driverId: driver.id,
      volumeMount: `${hostMountPath}:${containerPath}`,
      containerPath,
      attached: false,
      detachOnCompensate: true,
    };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    if (!out.detachOnCompensate) {
      ctx.log(`Preserved pre-existing attachment for volume ${out.volumeId}`);
      return;
    }
    const picked = prior["pick_or_provision_server"] as ServerOut | undefined;
    const server = picked ? db.getServer(picked.serverId) ?? undefined : undefined;
    const driver = requireStorageDriver(out.driverId);
    try { await driver.detach(out.volumeId, server); } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    db.retireVolume({
      providerVolumeId: out.volumeId,
      driverId: out.driverId,
      formerResourceType: "app",
      formerResourceId: 0,
      formerResourceName: ctx.input.app_name || "unknown-app",
      reason: `deployment operation #${ctx.opId} compensated`,
      retentionClass: out.attached ? "user" : "provisional",
    });
    ctx.log(`Retained detached volume ${out.volumeId} for recovery`);
  },
};

const insertAppRow: Step<DeployInput, InsertAppOut> = {
  name: "insert_app_row",
  label: "Register app",
  async probe(ctx, prior) {
    const req = ctx.input;
    const existing = db.getAppByName(req.app_name);
    if (!existing) return null;
    const replicas = db.getReplicas(existing.id);
    if (replicas.length === 0) {
      throw new FatalProbeError(
        `Cannot adopt app "${req.app_name}": the existing app has no primary replica`,
      );
    }
    const replica = replicas[0];
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return null;
    if (replica.server_id !== server.serverId) {
      throw new FatalProbeError(
        `Cannot adopt app "${req.app_name}": its existing replica is on a different server`,
      );
    }
    const useDomain =
      existing.domain || resolveAppDomain(req, domainSettings(server), server.ingressIp).domain;
    const useInternalTls = useDomain.endsWith(".nip.io");

    // Resolve flat env vars from the existing app's environment (idempotent).
    const flatEnvVars: Record<string, string> = {};
    if (existing.environment_id) {
      const envRow = db.getEnvironment(existing.environment_id);
      if (envRow) {
        const { resolveAppEnvVars } = await import("../../shared/env-crypto.ts");
        const resolved = await resolveAppEnvVars(existing);
        for (const key of Object.keys(platformEnvVars(existing))) delete resolved[key];
        Object.assign(flatEnvVars, resolved);
      }
    }
    ctx.log(`adopting existing app row id=${existing.id} (already inserted in prior attempt)`);
    return {
      appId: existing.id,
      replicaId: replica.id,
      containerName: req.app_name,
      hostPort: replica.host_port,
      domain: useDomain,
      useInternalTls,
      environmentId: existing.environment_id,
      flatEnvVars,
    };
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    return db.getApp(out.appId) === null;
  },
  async run(ctx, prior) {
    const req = resolveDeployRequestEnvironmentIds(ctx.input);
    Object.assign(ctx.input, req);
    const server = prior["pick_or_provision_server"] as ServerOut;
    const volume = prior["create_volume"] as VolumeOut;

    const { domain: useDomain } = resolveAppDomain(req, domainSettings(server), server.ingressIp);
    const useInternalTls = useDomain.endsWith(".nip.io");

    // Resolve environment + flat env vars (must be reproducible; idempotent
    // env creation uses unique-name retry). A deploy's env_vars are the caller's
    // already-merged manifest defaults + --set overrides (existing-wins keys are
    // dropped client-side). We LAYER them onto the target environment — linked
    // or freshly created — overwriting by key.
    let environmentId: number | null = req.environment_id ?? null;
    const flatEnvVars: Record<string, string> = {};

    // A non-production deploy target (staging/dev) links to the environment the
    // caller selected — passed as req.environment_id, resolved like any app's
    // env below. There is no live inheritance from production: the sibling gets
    // exactly the environment it points at (typically a user-made copy of prod).
    // Back-compat: legacy clients sent env_label/sibling_of for what are now
    // target/target_of — honor them (identical semantics) when the new fields
    // are absent.
    const targetTag = req.target ?? req.env_label;
    const targetOf = req.target_of ?? req.sibling_of;

    const incoming =
      req.env_vars &&
      (Array.isArray(req.env_vars) ? req.env_vars.length > 0 : Object.keys(req.env_vars).length > 0)
        ? await processIncomingEnvVars(req.env_vars)
        : null;

    const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
    if (environmentId) {
      const envRow = db.getEnvironment(environmentId);
      if (envRow) {
        // Overlay incoming vars on top of the linked env and persist (overwrite
        // by key). Idempotent: a retry re-overlays the same keys.
        if (incoming && incoming.entries.length > 0) {
          const overlaid = new Set(incoming.entries.map((e) => e.key));
          const base = parseEnvVars(envRow.env_vars).entries.filter((e) => !overlaid.has(e.key));
          db.updateEnvironment(envRow.id, envRow.name, serializeEnvVars([...base, ...incoming.entries]));
        }
        Object.assign(flatEnvVars, await resolveEnvVarsForDeploy(db.getEnvironment(environmentId)!.env_vars));
      }
    } else if (incoming && incoming.entries.length > 0) {
      let envName = req.app_name;
      let suffix = 1;
      while (db.getEnvironments().find((e) => e.name === envName)) {
        envName = `${req.app_name}-${suffix++}`;
      }
      const envRow = db.insertEnvironment(envName, serializeEnvVars(incoming.entries));
      environmentId = envRow.id;
      Object.assign(flatEnvVars, await resolveEnvVarsForDeploy(envRow.env_vars));
    }
    const projectedFlatEnvVars = projectEnvVars(flatEnvVars, req.env_projection);

    const extraVolumes = (req.extra_volumes || []).map(
      (v) => `${v.host_path}:${v.container_path}`,
    );

    // Durability policy -> concrete placement-spread + replica floors, applied
    // AT INSERT so the SLO/placement layer enforces them from the first tick.
    const scaling = normalizeAppScaling(req);
    // Single atomic commit: app row + first replica + volume intent.
    // metadata. Without the transaction a mid-step crash could leave the DB
    // with an app but no DNS / volume / extra-volume rows.
    const { app, replica } = dbInstance.transaction(() => {
      const result = db.insertAppWithFirstReplica(
        {
          name: req.app_name,
          domain: useDomain,
          image_ref: req.image_ref!,
          container_port: req.container_port,
          env_vars: serializeEnvVars([]),
          auth_password: req.auth_password,
          environment_id: environmentId ?? undefined,
          env_projection: req.env_projection,
          public: req.public,
          health_check: req.health_check,
          health_check_mode: req.health_check_mode,
          health_check_command: req.health_check_command,
          health_check_file: req.health_check_file,
          health_check_max_age_seconds: req.health_check_max_age_seconds,
          health_check_expected_statuses: req.health_check_expected_statuses,
          internal_protocol: req.internal_protocol,
          sticky: req.sticky,
          rate_limit_rps: req.rate_limit_rps,
          ip_allowlist: req.ip_allowlist,
          health_check_path: req.health_check_path,
          compress: req.compress,
          public_port: req.public_port,
          public_protocol: req.public_protocol,
          durability_class: scaling.durability_class,
          max_per_host: scaling.max_per_host,
          min_locations: scaling.min_locations,
          placement_pool: req.placement_pool,
          target: targetTag,
          target_of: targetOf,
          desired_volume_id: req.volume_id ?? "",
          desired_volume_size: req.volume_size ?? 0,
          desired_volume_path: req.volume_path ?? "/data",
          desired_volume_driver: volume?.driverId ?? req.volume_driver ?? "",
          command: req.command,
          cap_add: req.cap_add,
          post_start_command: req.post_start_command,
        },
        server.serverId,
      );
      if (ctx.triggeredBy) db.updateAppDeployedBy(result.app.id, ctx.triggeredBy);
      db.updateAppScaling(result.app.id, {
        desired_replicas: scaling.desired_replicas,
        min_replicas: scaling.min_replicas,
        max_replicas: scaling.max_replicas,
        autoscale_enabled: scaling.autoscale_enabled,
        autoscale_cpu_threshold: scaling.autoscale_cpu_threshold,
        autoscale_mem_threshold: scaling.autoscale_mem_threshold,
        autoscale_req_threshold: scaling.autoscale_req_threshold,
        autoscale_cooldown: scaling.autoscale_cooldown,
        scale_to_zero_after: scaling.scale_to_zero_after,
      });
      if (volume) {
        db.updateAppVolume(result.app.id, volume.volumeId, volume.volumeMount, volume.attached, volume.driverId);
        if (volume.attached) db.deleteRetiredVolume(volume.volumeId);
      }
      if (extraVolumes.length > 0) {
        db.updateAppExtraVolumes(result.app.id, extraVolumes);
      }
      if (typeof req.memory_mb === "number" && req.memory_mb > 0) {
        db.updateAppMemory(result.app.id, req.memory_mb);
      }
      if (typeof req.cpu_limit === "number" && req.cpu_limit > 0) {
        db.updateAppCpu(result.app.id, req.cpu_limit);
      }
      return result;
    })();

    const storage = resolveStorageBindings(req.storage);
    try {
      await prepareStorageBindings(app, storage);
      saveAppStorage(app.id, storage, true);
    } catch (error) {
      deleteAppStorage(app.id);
      db.deleteApp(app.id);
      throw error;
    }
    return {
      appId: app.id,
      replicaId: replica.id,
      containerName: req.app_name,
      hostPort: replica.host_port,
      domain: useDomain,
      useInternalTls,
      environmentId,
      flatEnvVars: projectedFlatEnvVars,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    // DB teardown of the half-created app. Deleting an already-gone row is a
    // no-op (so retry is safe, and probeCompensated skips once the app row is
    // gone); let a genuine failure PROPAGATE rather than leave an orphaned app
    // row behind a clean `compensated`.
    db.deleteReplica(out.replicaId);
    db.deleteApp(out.appId);
  },
};

const setupVolumeBindMount: Step<DeployInput, { ok: true }> = {
  name: "setup_volume_bind_mount",
  label: "Bind volume mount",
  async run(ctx, prior) {
    const volume = prior["create_volume"] as VolumeOut;
    if (!volume) return { ok: true };
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;

    const hostMountPath = volume.volumeMount.split(":")[0];
    const serverRow = db.getServer(server.serverId);
    if (!serverRow) throw new Error(`Server ${server.serverId} not found`);
    const driver = requireStorageDriver(volume.driverId);
    // Provider mounts can settle asynchronously after volume creation; retry
    // a small handful of times before giving up.
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await driver.ensureMount({
          server: serverRow,
          volumeId: volume.volumeId,
          hostPath: hostMountPath,
          blockName: `app-${appOut.appId}`,
        });
        ctx.log(`Storage mount ready: ${hostMountPath} (${driver.id})`);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        await Bun.sleep(3000);
      }
    }
    // This step has not completed, so the runner will not call its own
    // compensate hook. Remove any partially-written fstab/bind state inline
    // before earlier steps detach/retire the provider volume.
    try {
      await driver.removeMount({
        server: serverRow,
        volumeId: volume.volumeId,
        hostPath: hostMountPath,
        blockName: `app-${appOut.appId}`,
      });
    } catch (rollbackError) {
      throw new Error(
        `Volume bind setup failed and its partial mount could not be removed: ${rollbackError}`,
        { cause: lastErr },
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  },
  async compensate(ctx, _out, prior) {
    const volume = prior["create_volume"] as VolumeOut;
    if (!volume) return;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    const appOut = prior["insert_app_row"] as InsertAppOut | undefined;
    if (!server || !appOut) return;
    const hostMountPath = volume.volumeMount.split(":")[0];
    try {
      const serverRow = db.getServer(server.serverId);
      if (!serverRow) return;
      await requireStorageDriver(volume.driverId).removeMount({
        server: serverRow,
        volumeId: volume.volumeId,
        hostPath: hostMountPath,
        blockName: `app-${appOut.appId}`,
      });
    } catch (err) {
      ctx.log(`Failed to remove bind mount: ${err}`);
    }
  },
};

const pullAndRunContainer: Step<DeployInput, ArtifactOut> = {
  name: "pull_and_run_container",
  label: "Pull and run immutable image",
  async probe(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return null;
    const hostKey = server.serverHostKey || undefined;
    // Adopt ONLY a container that is actually running. A container left behind
    // by an interrupted `docker run` (created/exited/stopped) must NOT be
    // adopted — adopting it would skip straight to health_check, which then
    // fails with "Container is not running" and rolls the whole deploy back.
    // Returning null here lets run() force-remove the dead container and start
    // a fresh one, so the container is guaranteed running after this step.
    if (await containerRunning(server.serverIp, req.app_name, hostKey)) {
      ctx.log(`adopting existing running container ${req.app_name}`);
      return {
        imageTag: req.image_ref!,
        imageDigest: req.image_ref!,
      };
    }
    return null;
  },
  async probeCompensated(_ctx, out, prior) {
    if (!out) return true;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    const appOut = prior["insert_app_row"] as InsertAppOut | undefined;
    if (!server || !appOut) return true;
    const exists = await containerExists(server.serverIp, appOut.containerName, server.serverHostKey || undefined);
    return !exists;
  },
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const volume = prior["create_volume"] as VolumeOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;

    const { mask } = await deploymentMasker(
      req,
      ctx.triggeredBy,
      Object.values(appOut.flatEnvVars),
    );
    const maskedLog = (line: string) => db.appendDeployLog(appOut.appId, mask(line));

    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    // First-deploy path bypasses resolveAppEnvVars (env vars were resolved
    // before the app row existed), so merge the platform OCD_INTERNAL_* vars
    // here. OCD_DEPLOY_TARGET is platform-owned; legacy OCD_INTERNAL_* values
    // remain user-overridable.
    const appRow = db.getApp(appOut.appId);
    const platform = appRow ? platformEnvVars(appRow) : null;
    const envVars = platform
      ? {
          ...platform,
          ...appOut.flatEnvVars,
          ...await appStorageEnv(appRow!.id),
          OCD_DEPLOY_TARGET: platform.OCD_DEPLOY_TARGET,
        }
      : appOut.flatEnvVars;

    const imageTag = req.image_ref!;
    const common = {
        name: req.app_name,
        port: req.container_port,
        hostPort: appOut.hostPort,
        envVars,
        volumeMount: volume?.volumeMount,
        extraVolumes: (req.extra_volumes || []).map((v) => `${v.host_path}:${v.container_path}`),
        bindAddr: containerBindAddr,
        memoryMb: req.memory_mb || undefined,
        cpus: req.cpu_limit || undefined,
        command: req.command,
        capAdd: req.cap_add,
        hostKey: server.serverHostKey || undefined,
        configRevision: appRow?.config_revision ?? 1,
        envHash: hashEnvironment(envVars),
    };
    let result;
    try {
      result = await pullImmutableImageAndRun(server.serverIp, {
        ...common,
        imageRef: req.image_ref!,
      }, (line) => {
        maskedLog(`[pull] ${line}`);
        ctx.log(`[pull] ${mask(line)}`);
      });
    } catch (error) {
      // A helper may fail after replacing/creating the container. Because this
      // step has not returned, its normal compensate hook is ineligible; own
      // the partial mutation here so DB teardown cannot leave a live orphan.
      try {
        await removeContainer(
          server.serverIp,
          appOut.containerName,
          server.serverHostKey || undefined,
        );
      } catch (rollbackError) {
        throw new Error(
          `Pull/run failed and its partial container could not be removed: ${rollbackError}`,
          { cause: error },
        );
      }
      throw error;
    }
    return {
      imageTag,
      imageDigest: "imageDigest" in result ? result.imageDigest : undefined,
      imageBytes: "imageBytes" in result ? result.imageBytes : undefined,
    };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!server || !appOut) return;
    try {
      const { mask } = await deploymentMasker(
        ctx.input,
        ctx.triggeredBy,
        Object.values(appOut.flatEnvVars),
      );
      const logs = await getContainerLogs(
        server.serverIp,
        appOut.containerName,
        200,
        server.serverHostKey || undefined,
      );
      for (const rawLine of logs.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        const line = mask(`[failed-container] ${rawLine}`);
        ctx.log(line);
        db.appendDeployLog(appOut.appId, line);
      }
    } catch (err) {
      ctx.log(`Could not capture failed container logs: ${err}`);
    }
    // Let a genuine failure to remove the container PROPAGATE so a leaked
    // container surfaces as `compensation_failed` rather than a false-clean
    // `compensated`. probeCompensated short-circuits this step once the
    // container is gone, so re-running the compensate is safe.
    await removeContainer(server.serverIp, appOut.containerName, server.serverHostKey || undefined);
    // The app row/container are operation-owned and are being compensated, so
    // an unreferenced OCD-managed layer is safe to prune.
    await sshExec(
      server.serverIp,
      `su - deploy -c ${JSON.stringify(
        `docker image prune -f --filter label=ocd.managed=true >/dev/null 2>&1 || true`,
      )}`,
      server.serverHostKey || undefined,
    );
  },
};

const syncIngressStep: Step<DeployInput, { domain: string }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(_ctx, prior) {
    const appOut = prior["insert_app_row"] as InsertAppOut;
    await syncAppIngress(appOut.appId);
    db.appendDeployLog(
      appOut.appId,
      appOut.domain
        ? `[ingress] Public ingress configured for ${appOut.domain}`
        : `[ingress] Internal ingress configured (private app)`,
    );
    return { domain: appOut.domain };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!appOut) return;
    try {
      await syncAllTraefik();
    } catch (err) {
      ctx.log(`Failed to remove ingress route: ${err}`);
    }
  },
};

const healthCheckStep: Step<DeployInput, { healthy: boolean; statusCode?: number }> = {
  name: "health_check",
  label: "Health check",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    // Generous window (10 attempts) so a slow first boot isn't failed early.
    // Apps with the HTTP probe opted out (databases, queue workers) only get
    // the container-is-running verification.
    const app = db.getApp(appOut.appId);
    if (!app) throw new Error("App row missing during health check");
    const health = await probeAppHealth(
      app, server.serverIp, req.app_name, containerBindAddr, appOut.hostPort,
      10, server.serverHostKey || undefined,
    );

    if (health.healthy) {
      const build = prior["pull_and_run_container"] as ArtifactOut | undefined;
      const replica = db.getReplica(appOut.replicaId);
      if (!replica) throw new Error("Replica row missing during attestation");
      db.updateReplicaStatus(replica.id, "attesting");
      const envVars = await import("../../shared/env-crypto.ts").then(({ resolveAppEnvVars }) => resolveAppEnvVars(app));
      const expected = {
        imageDigest: build?.imageDigest || req.image_ref || build?.imageTag || latestDesiredImage(app),
        envHash: hashEnvironment(envVars),
        configRevision: app.config_revision,
      };
      const attestation = await attestReplica(app, replica, tenantServerRow, expected);
      if (!attestation.ok) {
        db.updateAppStatus(appOut.appId, "unhealthy");
        throw new Error(`Replica ${replica.id} revision attestation failed: ${attestation.error}`);
      }
      if (app.post_start_command) {
        await runAppPostStartCommand(
          server.serverIp,
          appOut.containerName,
          app.post_start_command,
          server.serverHostKey || undefined,
        );
        db.appendDeployLog(appOut.appId, "[post-start] Setup completed");
      }
      db.appendDeployLog(
        appOut.appId,
        app.health_check_mode === "container" || !app.health_check
          ? "[health] HTTP probe disabled; container is running"
          : `[health] ${app.health_check_mode || "http"} readiness passed`,
      );
      db.updateAppStatus(appOut.appId, "running");
      db.updateReplicaStatus(appOut.replicaId, "running");
      db.markAppEnvironmentFresh(appOut.appId);
    } else {
      // Hard failure: a deploy that never becomes healthy must fail the op so
      // its compensations tear down the half-deployed app rather than leaving
      // it stuck 'unhealthy'.
      const detail = health.error || `HTTP ${health.statusCode ?? "no response"}`;
      db.appendDeployLog(appOut.appId, `[health] ${detail}`);
      db.updateAppStatus(appOut.appId, "unhealthy");
      db.updateReplicaStatus(appOut.replicaId, "unhealthy");
      throw new Error(`App did not become healthy after deploy: ${detail}`);
    }
    return { healthy: health.healthy, statusCode: health.statusCode };
  },
};

const recordDeploymentHistory: Step<DeployInput, { deploymentId: number; gitCommit: string }> = {
  name: "record_deployment_history",
  label: "Record deployment",
  async probe(ctx, prior) {
    const appOut = prior["insert_app_row"] as InsertAppOut | undefined;
    if (!appOut) return null;
    // Operation identity is exact; image tags are intentionally reusable and
    // must not cause a later explicit deploy to adopt an older history row.
    const row = dbInstance
      .query("SELECT id, git_commit FROM deployment_history WHERE operation_id = ?")
      .get(ctx.opId) as { id: number; git_commit: string } | null;
    if (!row) return null;
    ctx.log(`adopting existing deployment_history row id=${row.id}`);
    return { deploymentId: row.id, gitCommit: row.git_commit };
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    const row = dbInstance
      .query("SELECT id FROM deployment_history WHERE id = ?")
      .get(out.deploymentId) as { id: number } | null;
    return row === null;
  },
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    const build = prior["pull_and_run_container"] as ArtifactOut;

    const gitCommit = req.git_commit || "";
    const row = db.insertDeployment({
      operation_id: ctx.opId,
      app_id: appOut.appId,
      image_tag: build.imageTag,
      image_digest: build.imageDigest || req.image_ref,
      image_size_bytes: build.imageBytes,
      env_hash: hashEnvironment(await import("../../shared/env-crypto.ts").then(({ resolveAppEnvVars }) => resolveAppEnvVars(db.getApp(appOut.appId)!))),
      git_commit: gitCommit,
      config_revision: db.getApp(appOut.appId)?.config_revision ?? 1,
      source: ctx.trigger === "ui" ? "manual" : ctx.trigger,
    });
    return { deploymentId: row.id, gitCommit };
  },
  async compensate(ctx, out) {
    if (!out) return;
    // Deliberately best-effort: a deployment_history row is audit metadata, not
    // a live resource — a stray row for a failed deploy leaks nothing, so it
    // must not block the rollback from reaching `compensated`.
    try {
      dbInstance.run("DELETE FROM deployment_history WHERE id = ?", [out.deploymentId]);
    } catch (err) {
      ctx.log(`Failed to delete deployment history row ${out.deploymentId}: ${err}`);
    }
  },
};

const finalizeDeploy: Step<DeployInput, { ok: true }> = {
  name: "finalize_deploy",
  label: "Finalize",
  async run(ctx, prior) {
    const req = ctx.input;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    // Multi-replica deploys just declare the desired count; the reconciler's
    // convergence loop brings the extra replicas up within a tick. Scaling
    // only needs a route the panel can fan out over the private network —
    // which every deployed app has (private apps via their internal
    // entrypoint, public apps via the panel), so the sole blocker is a public
    // app that somehow resolved to no domain at all.
    const app = db.getApp(appOut.appId);
    if (!app) throw new Error("App disappeared before replica convergence");
    const current = db.getReplicas(app.id);
    const desired = app.volume_id ? 1 : app.desired_replicas;
    if (desired > current.length) {
      db.appendDeployLog(app.id, `[scale] Converging ${current.length} → ${desired} replicas before success`);
      await scaleUp(app, current, current.length, desired, (phase, detail) => {
        ctx.log(`[${phase}] ${detail}`);
        db.appendDeployLog(app.id, `[${phase}] ${detail}`);
      }, undefined, undefined, req.server_provisioning_approved === true, `op${ctx.opId}`);
    }
    const finalReplicas = db.getReplicas(app.id);
    const divergent = finalReplicas.filter((replica) => replica.status !== "running" || !replica.attested_at);
    if (finalReplicas.length !== desired || divergent.length > 0) {
      throw new Error(
        `Replica convergence incomplete: desired=${desired}, actual=${finalReplicas.length}, unattested=${divergent.map((r) => r.id).join(",") || "none"}`,
      );
    }
    await commitManifestDeliverySource(appOut.appId, req.delivery_source);
    if (req.manifest_path && req.manifest_hash) {
      db.recordAppManifestApplied(appOut.appId, req.manifest_path, req.manifest_hash);
    }
    if (req.stack_manifest_path !== undefined) {
      db.updateAppStackManifestPath(appOut.appId, req.stack_manifest_path);
    }
    const deployment = prior["record_deployment_history"] as { deploymentId: number } | undefined;
    const finalRevision = db.getApp(appOut.appId)?.config_revision;
    if (deployment && finalRevision != null) {
      db.updateDeploymentConfigRevision(deployment.deploymentId, finalRevision);
    }

    db.appendDeployLog(appOut.appId, `[done] App deployed successfully`);
    log("done", `op#${ctx.opId} completed for app ${appOut.containerName}`);
    return { ok: true };
  },
};

// --- Op kind definition ----------------------------------------------------

const deployOp: OpKindDefinition<DeployInput> = {
  kind: "deploy",
  label: "Deploy app",
  resourceKeys: (input) => [`app:create:${input.app_name}`],
  steps: [
    pickOrProvisionServer,
    createVolume,
    insertAppRow,
    setupVolumeBindMount,
    pullAndRunContainer,
    syncIngressStep,
    healthCheckStep,
    recordDeploymentHistory,
    finalizeDeploy,
  ],
};

registerOp(deployOp as OpKindDefinition<any>);

export default deployOp;
export type { DeployInput };
