import type { DeployRequest, Server } from "../../shared/rpc.ts";
import dbInstance, * as db from "../../shared/db.ts";
import { hetzner, hetznerDns } from "../../shared/providers/index.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import { resolveDurability } from "../../shared/durability.ts";
import {
  sshExec,
  cloneRepo,
  cloneAndBuild,
  removeContainer,
  healthCheck,
  containerRunningCheck,
  containerExists,
  containerRunning,
} from "../../shared/remote/index.ts";
import { syncAppIngress, syncAllTraefik } from "../scale/traefik-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import * as github from "../../shared/github.ts";
import { validateDeployRequest, assertSafeHostPath } from "../../shared/validate.ts";
import { createMasker } from "../../shared/mask.ts";
import { processIncomingEnvVars, serializeEnvVars, parseEnvVars, platformEnvVars, projectEnvVars } from "../../shared/env-crypto.ts";
import { getProviderToken } from "../../shared/secret-store.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { getOrResolveZoneName } from "../../shared/dns-zone.ts";
import { provisionServer } from "../provision-server.ts";
import { resolve4 } from "node:dns/promises";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";

type DeployInput = DeployRequest;

type ServerOut = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
  provisioned: boolean;
  providerServerId?: string;
  ingressIp: string;
  /** DNS zone name for auto-domains, resolved once in this step so every
   *  later step (and crash-replay probes) sees the same value. "" when no
   *  zone is configured or the deploy doesn't need an auto-domain. */
  zoneName?: string;
};

type DnsOut = {
  recordId: string;
  zoneId: string;
  name: string;
  type: string;
  value: string;
} | null;

type VolumeOut = {
  volumeId: string;
  volumeMount: string;
  containerPath: string;
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
  dockerfilePath: string;
};

type CloneOut = { ok: true };

type BuildOut = {
  imageTag: string;
};

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [engine:deploy:${context}]`, ...args);
}

async function resolveDomainIps(domain: string, timeoutMs = 3000): Promise<string[]> {
  try {
    return await Promise.race([
      resolve4(domain),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
    ]);
  } catch {
    return [];
  }
}

async function findVolumeByName(name: string) {
  try {
    const all = await hetzner.volumes.list();
    return all.find((v) => v.name === name) ?? null;
  } catch {
    return null;
  }
}

export function appVolumeName(appName: string, opId: number): string {
  return `ocd-${appName}-op${opId}`;
}

async function buildMasker(input: DeployInput, userId: string) {
  const providerToken = await getProviderToken();
  const resolvedGitToken = await resolveGitHubToken(userId || undefined);
  const githubPat = resolvedGitToken || undefined;
  const envVarValues = input.env_vars
    ? Array.isArray(input.env_vars)
      ? input.env_vars.map((e) => e.value)
      : Object.values(input.env_vars)
    : [];
  const secretValues = [
    providerToken,
    ...(githubPat ? [githubPat] : []),
    ...envVarValues,
  ];
  return { mask: createMasker(secretValues), githubPat };
}

/** Resolve where the app is reachable from outside. Private apps get no
 *  domain at all — no DNS record, no public route, internal ingress only.
 *  Public apps without an explicit domain get the auto-domain
 *  `<app>.<zone>` when a DNS zone is configured; nip.io remains the
 *  fallback only when no zone is configured (or its name is unresolvable). */
export function resolveAppDomain(
  req: { app_name: string; domain?: string; public?: boolean },
  settings: { dns_zone_id?: string; dns_zone_name?: string },
  ingressIp: string,
): { domain: string; managedDns: boolean } {
  if (req.public === false) return { domain: "", managedDns: false };
  if (req.domain) return { domain: req.domain, managedDns: !!settings.dns_zone_id };
  if (settings.dns_zone_id && settings.dns_zone_name) {
    return { domain: `${req.app_name}.${settings.dns_zone_name}`, managedDns: true };
  }
  return { domain: `${req.app_name}.${ingressIp}.nip.io`, managedDns: false };
}

/** Settings view for resolveAppDomain inside deploy steps: the zone name from
 *  the pick_or_provision_server output wins over the live setting so domain
 *  resolution is deterministic across run+probe replays of the saga. */
function domainSettings(server: ServerOut): { dns_zone_id?: string; dns_zone_name?: string } {
  const settings = db.getSettings();
  return {
    dns_zone_id: settings.dns_zone_id,
    dns_zone_name: server.zoneName ?? settings.dns_zone_name,
  };
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

    // Auto-domain zone name: resolve (and cache) it once in this step so the
    // whole saga — including crash-replay probes of later steps — sees one
    // consistent value via this step's persisted output. Only needed when the
    // deploy would actually mint an auto-domain.
    const zoneName =
      req.public === false || req.domain ? "" : await getOrResolveZoneName();
    if (req.public !== false && !req.domain && settings.dns_zone_id && !zoneName) {
      ctx.log(
        `dns_zone_id is set but the zone name could not be resolved — falling back to nip.io`,
      );
    }

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
        zoneName,
      };
    }
    const existingReady = db.getServers().find((s: Server) => s.status === "ready");
    if (existingReady) {
      const ingressIp = panelServerRow?.ipv4 || existingReady.ipv4;
      return {
        serverId: existingReady.id,
        serverIp: existingReady.ipv4,
        serverHostKey: existingReady.ssh_host_key || "",
        provisioned: false,
        ingressIp,
        zoneName,
      };
    }
    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    const location = settings.default_location;
    if (!location) throw new Error("No default server location configured — set one in Settings");

    const newServer = await provisionServer({
      serverType,
      location,
      name: `ocd-${req.app_name}-${Date.now()}`,
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
      zoneName,
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

// Note: no probe()/probeCompensated() here — both DNS providers' createRecord
// and deleteRecord are naturally idempotent (match by name+type+value), so
// safe to re-run after a crash without any explicit adopt-skip.
const createDnsRecord: Step<DeployInput, DnsOut> = {
  name: "create_dns_record",
  label: "Create DNS record",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const dnsZoneId = db.getSettings().dns_zone_id;
    if (req.public === false) return null; // private apps have no public ingress
    if (!dnsZoneId) return null;

    // Same resolution as insert_app_row — covers explicit domains and
    // auto-domains (<app>.<zone>); nip.io fallbacks get no managed record.
    const { domain, managedDns } = resolveAppDomain(req, domainSettings(server), server.ingressIp);
    if (!domain || !managedDns) return null;

    // Record name: an auto-domain is always a direct child of the zone;
    // explicit domains keep the strip-the-last-two-labels behavior.
    let subdomain = req.app_name;
    if (req.domain) {
      const parts = req.domain.split(".");
      subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
    }

    // Idempotency: check provider for existing record.
    const dns = hetznerDns;
    try {
      const record = await dns.createRecord({
        zoneId: dnsZoneId,
        name: subdomain,
        type: "A",
        value: server.ingressIp,
      });
      return {
        recordId: record.id,
        zoneId: dnsZoneId,
        name: subdomain,
        type: "A",
        value: server.ingressIp,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // DNS creation is best-effort — log and proceed without a managed record.
      ctx.log(`DNS record creation failed (continuing): ${msg}`);
      return null;
    }
  },
  async compensate(ctx, out) {
    if (!out) return;
    // deleteRecord matches by name+type+value and is idempotent (a missing
    // record is a no-op — see the forward-step note), so let a genuine failure
    // PROPAGATE rather than orphan an A record that points at a server for an
    // app that no longer exists behind a clean `compensated`.
    const dns = hetznerDns;
    await dns.deleteRecord({
      zoneId: out.zoneId,
      name: out.name,
      type: out.type,
      value: out.value,
    });
  },
};

const createVolume: Step<DeployInput, VolumeOut> = {
  name: "create_volume",
  label: "Create volume",
  async probe(ctx, prior) {
    const req = ctx.input;
    if (!req.volume_size || req.volume_size <= 0) return null;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const settings = db.getSettings();
    let providerServerId = server.providerServerId;
    if (!providerServerId) providerServerId = db.getServer(server.serverId)?.provider_id;
    if (!providerServerId) return null;
    const location = db.getServer(server.serverId)?.location || settings.default_location || "nbg1";
    const volName = appVolumeName(req.app_name, ctx.opId);
    const existing = await findVolumeByName(volName);
    if (!existing) return null;
    const retired = db.getRetiredVolumes().find(
      (row) => row.provider_volume_id === existing.providerId,
    );
    if (retired) {
      throw new Error(
        `Refusing to adopt retained volume ${existing.providerId} (${volName}); it belongs to ` +
        `${retired.former_resource_type}:${retired.former_resource_name}.`,
      );
    }
    if (
      existing.sizeGb !== req.volume_size ||
      existing.location !== location ||
      (existing.serverId != null && existing.serverId !== providerServerId)
    ) {
      throw new Error(
        `Volume name collision for ${volName}: provider volume ${existing.providerId} ` +
        "does not match requested size/location/server. Refusing implicit adoption.",
      );
    }
    const hostMountPath = `/mnt/${volName}`;
    const containerPath = req.volume_path || "/data";
    ctx.log(`adopting existing volume ${existing.providerId} (${volName})`);
    return {
      volumeId: existing.providerId,
      volumeMount: `${hostMountPath}:${containerPath}`,
      containerPath,
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
    const settings = db.getSettings();
    const compute = hetzner;
    if (!compute.volumes) {
      throw new Error(`Provider "${compute.name}" does not support managed volumes`);
    }

    let providerServerId = server.providerServerId;
    if (!providerServerId) {
      const existingServer = db.getServer(server.serverId);
      if (!existingServer) throw new Error(`Server ${server.serverId} not found`);
      providerServerId = existingServer.provider_id;
    }

    const volName = appVolumeName(req.app_name, ctx.opId);
    const vol = await compute.volumes.create({
      name: volName,
      sizeGb: req.volume_size,
      serverId: providerServerId,
      location: settings.default_location || "nbg1",
    });
    const hostMountPath = `/mnt/${volName}`;
    const containerPath = req.volume_path || "/data";
    // Host bind-mount setup happens in a later step (setup_volume_bind_mount)
    // once we have an app.id to tag the fstab block with.
    ctx.log(`Volume ready (${req.volume_size}GB at ${containerPath})`);
    return {
      volumeId: vol.providerId,
      volumeMount: `${hostMountPath}:${containerPath}`,
      containerPath,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    const compute = hetzner;
    try { await compute.volumes?.detach(out.volumeId); } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    db.retireVolume({
      providerVolumeId: out.volumeId,
      formerResourceType: "app",
      formerResourceId: 0,
      formerResourceName: ctx.input.app_name || "unknown-app",
      reason: `deployment operation #${ctx.opId} compensated`,
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
    if (replicas.length === 0) return null;
    const replica = replicas[0];
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server || replica.server_id !== server.serverId) return null;
    const useDomain =
      existing.domain || resolveAppDomain(req, domainSettings(server), server.ingressIp).domain;
    const useInternalTls = useDomain.endsWith(".nip.io");
    const dockerfilePath = existing.dockerfile_path || req.dockerfile_path || "Dockerfile";

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
      dockerfilePath,
    };
  },
  async probeCompensated(_ctx, out) {
    if (!out) return true;
    return db.getApp(out.appId) === null;
  },
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const dns = prior["create_dns_record"] as DnsOut;
    const volume = prior["create_volume"] as VolumeOut;

    const { domain: useDomain } = resolveAppDomain(req, domainSettings(server), server.ingressIp);
    const useInternalTls = useDomain.endsWith(".nip.io");
    const dockerfilePath = req.dockerfile_path || "Dockerfile";

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
    const {
      durabilityClass: durability,
      maxPerHost,
      minLocations,
      minReplicas: durFloor,
      desiredReplicas,
    } = resolveDurability(req.durability_class, req.replicas);
    // Single atomic commit: app row + first replica + DNS record + volume
    // metadata. Without the transaction a mid-step crash could leave the DB
    // with an app but no DNS / volume / extra-volume rows.
    const { app, replica } = dbInstance.transaction(() => {
      const result = db.insertAppWithFirstReplica(
        {
          name: req.app_name,
          domain: useDomain,
          git_repo: req.git_repo,
          git_branch: req.git_branch,
          dockerfile_path: dockerfilePath,
          docker_context: req.docker_context,
          container_port: req.container_port,
          env_vars: serializeEnvVars([]),
          auth_password: req.auth_password,
          environment_id: environmentId ?? undefined,
          env_projection: req.env_projection,
          public: req.public,
          health_check: req.health_check,
          internal_protocol: req.internal_protocol,
          sticky: req.sticky,
          rate_limit_rps: req.rate_limit_rps,
          ip_allowlist: req.ip_allowlist,
          health_check_path: req.health_check_path,
          compress: req.compress,
          public_port: req.public_port,
          public_protocol: req.public_protocol,
          durability_class: durability,
          max_per_host: maxPerHost,
          min_locations: minLocations,
          placement_pool: req.placement_pool,
          target: targetTag,
          target_of: targetOf,
        },
        server.serverId,
      );
      if (ctx.triggeredBy) db.updateAppDeployedBy(result.app.id, ctx.triggeredBy);
      // Durability floors the replica count; do it here (not just at finalize)
      // so the floor holds even when the deploy asks for a single replica.
      if (durability !== "none") {
        db.updateAppScaling(result.app.id, {
          desired_replicas: desiredReplicas,
          min_replicas: durFloor,
          max_replicas: Math.max(desiredReplicas, durFloor),
        });
      }
      if (typeof req.scale_to_zero_after === "number") {
        db.updateAppScaling(result.app.id, { scale_to_zero_after: req.scale_to_zero_after });
      }
      if (dns) {
        db.insertDnsRecord({
          app_id: result.app.id,
          zone_id: dns.zoneId,
          record_id: `${dns.name}/${dns.type}/${dns.value}`,
          name: dns.name,
          type: dns.type,
          value: dns.value,
        });
      }
      if (volume) {
        db.updateAppVolume(result.app.id, volume.volumeId, volume.volumeMount);
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

    return {
      appId: app.id,
      replicaId: replica.id,
      containerName: req.app_name,
      hostPort: replica.host_port,
      domain: useDomain,
      useInternalTls,
      environmentId,
      flatEnvVars: projectedFlatEnvVars,
      dockerfilePath,
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
    const { ensureVolumeBindMount } = await import("../hetzner/host-mounts.ts");
    // Hetzner's automount can lag a few seconds after volume create; retry
    // a small handful of times before giving up.
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await ensureVolumeBindMount({
          serverIp: server.serverIp,
          hostKey: server.serverHostKey || undefined,
          hetznerVolumeId: volume.volumeId,
          hostMountPath,
          blockName: `app-${appOut.appId}`,
        });
        ctx.log(`Bind mount ready: ${hostMountPath} -> /mnt/HC_Volume_${volume.volumeId}`);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        await Bun.sleep(3000);
      }
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
      const { removeVolumeBindMount } = await import("../hetzner/host-mounts.ts");
      await removeVolumeBindMount({
        serverIp: server.serverIp,
        hostKey: server.serverHostKey || undefined,
        hostMountPath,
        blockName: `app-${appOut.appId}`,
      });
    } catch (err) {
      ctx.log(`Failed to remove bind mount: ${err}`);
    }
  },
};

const cloneRepoStep: Step<DeployInput, CloneOut> = {
  name: "clone_repo",
  label: "Clone repository",
  async probe(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return null;
    const check = await sshExec(
      server.serverIp,
      `[ -d /home/deploy/apps/${req.app_name}/.git ] && echo yes || echo no`,
      server.serverHostKey || undefined,
    );
    if (check.stdout.trim() === "yes") {
      ctx.log(`repo already cloned at /home/deploy/apps/${req.app_name} — adopting`);
      return { ok: true };
    }
    return null;
  },
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    const { mask, githubPat } = await buildMasker(req, ctx.triggeredBy);
    await cloneRepo(server.serverIp, req.app_name, req.git_repo, githubPat, (line) => {
      db.appendDeployLog(appOut.appId, mask(`[clone] ${line}`));
      ctx.log(`[clone] ${mask(line)}`);
    }, req.git_branch, server.serverHostKey || undefined);
    if (req.git_sha) {
      if (!/^[0-9a-f]{7,64}$/i.test(req.git_sha)) throw new Error("Invalid webhook commit SHA");
      const checkedOut = await sshExec(
        server.serverIp,
        `su - deploy -c ${JSON.stringify(`cd /home/deploy/apps/${req.app_name} && git checkout --detach ${req.git_sha}`)}`,
        server.serverHostKey || undefined,
      );
      if (checkedOut.exitCode !== 0) throw new Error(`Could not check out webhook commit ${req.git_sha}`);
      ctx.log(`Checked out webhook commit ${req.git_sha}`);
    }
    return { ok: true };
  },
  async compensate(ctx, _out, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return;
    try {
      await sshExec(
        server.serverIp,
        `su - deploy -c "rm -rf /home/deploy/apps/${req.app_name}"`,
        server.serverHostKey || undefined,
      );
    } catch (err) {
      ctx.log(`Failed to remove cloned repo dir: ${err}`);
    }
  },
};

const buildAndRunContainer: Step<DeployInput, BuildOut> = {
  name: "build_and_run_container",
  label: "Build and run container",
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
        imageTag: `${req.app_name}:latest`,
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

    const { mask, githubPat } = await buildMasker(req, ctx.triggeredBy);
    const maskedLog = (line: string) => db.appendDeployLog(appOut.appId, mask(line));

    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    // First-deploy path bypasses resolveAppEnvVars (env vars were resolved
    // before the app row existed), so merge the platform OCD_INTERNAL_* vars
    // here. User-defined vars with the same key win.
    const appRow = db.getApp(appOut.appId);
    const envVars = appRow
      ? { ...platformEnvVars(appRow), ...appOut.flatEnvVars }
      : appOut.flatEnvVars;

    let imageTag = `${req.app_name}:latest`;
    const result = await cloneAndBuild(
      server.serverIp,
      {
        name: req.app_name,
        gitRepo: req.git_repo,
        port: req.container_port,
        hostPort: appOut.hostPort,
        envVars,
        volumeMount: volume?.volumeMount,
        extraVolumes: (req.extra_volumes || []).map((v) => `${v.host_path}:${v.container_path}`),
        dockerfilePath: req.dockerfile_path,
        dockerContext: req.docker_context,
        gitToken: githubPat,
        gitBranch: req.git_branch,
        bindAddr: containerBindAddr,
        skipClone: true,
        memoryMb: req.memory_mb || undefined,
        cpus: req.cpu_limit || undefined,
        hostKey: server.serverHostKey || undefined,
      },
      (line) => {
        maskedLog(`[build] ${line}`);
        ctx.log(`[build] ${mask(line)}`);
      },
    );
    if (result.imageTag) imageTag = result.imageTag;

    return { imageTag };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!server || !appOut) return;
    // Let a genuine failure to remove the container PROPAGATE so a leaked
    // container surfaces as `compensation_failed` rather than a false-clean
    // `compensated`. probeCompensated short-circuits this step once the
    // container is gone, so re-running the compensate is safe.
    await removeContainer(server.serverIp, appOut.containerName, server.serverHostKey || undefined);
  },
};

const syncIngressStep: Step<DeployInput, { domain: string }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const dns = prior["create_dns_record"] as DnsOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;

    // Private apps have no public domain — nothing to resolve.
    if (req.public !== false && req.domain && !appOut.useInternalTls && !dns) {
      const resolved = await resolveDomainIps(req.domain);
      if (resolved.length === 0) {
        throw new Error(
          `DNS lookup for ${req.domain} returned no A records. Create an A record pointing to ${server.ingressIp} and retry (DNS can take a few minutes to propagate).`,
        );
      }
      if (!resolved.includes(server.ingressIp)) {
        throw new Error(
          `Domain ${req.domain} resolves to ${resolved.join(", ")} but the ingress server is ${server.ingressIp}. Update the A record to ${server.ingressIp} (Let's Encrypt will fail to issue a certificate otherwise) and retry.`,
        );
      }
    }

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
    const httpProbe = req.health_check !== false;
    const health = httpProbe
      ? await healthCheck(server.serverIp, req.app_name, containerBindAddr, appOut.hostPort, 10, server.serverHostKey || undefined, req.health_check_path)
      : await containerRunningCheck(server.serverIp, req.app_name, 10, server.serverHostKey || undefined);

    if (health.healthy) {
      db.appendDeployLog(appOut.appId, httpProbe
        ? `[health] Health check passed (HTTP ${health.statusCode})`
        : `[health] HTTP probe disabled; container is running`);
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
    const build = prior["build_and_run_container"] as BuildOut | undefined;
    if (!appOut || !build) return null;
    // The newest row for this app + image_tag is treated as "ours" if we
    // re-enter — avoids inserting a duplicate history row.
    const row = dbInstance
      .query("SELECT id, git_commit FROM deployment_history WHERE app_id = ? AND image_tag = ? ORDER BY id DESC LIMIT 1")
      .get(appOut.appId, build.imageTag) as { id: number; git_commit: string } | null;
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
    const build = prior["build_and_run_container"] as BuildOut;

    const gitCommitResult = await sshExec(
      server.serverIp,
      `su - deploy -c "cd /home/deploy/apps/${req.app_name} && git rev-parse --short HEAD 2>/dev/null || echo unknown"`,
      server.serverHostKey || undefined,
    );
    const gitCommit = gitCommitResult.stdout.trim();
    const row = db.insertDeployment({
      app_id: appOut.appId,
      image_tag: build.imageTag,
      git_commit: gitCommit,
      config_revision: db.getApp(appOut.appId)?.config_revision ?? 1,
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

/**
 * The environment this app's `<name>-staging` sibling will deploy with, or null
 * when staging isn't wanted.
 *
 * An explicit `webhook_staging_environment_id` wins. Otherwise a manifest that
 * only declares intent (`webhook.staging: true` → `webhook_staging`) gets an
 * environment MINTED here, as a copy of the app's own — the same bargain the
 * app's production environment already gets on the no-`--env` path above, and
 * the same one a stack makes for its members. So `webhook.staging: true` is
 * self-sufficient: it means the same thing standalone as it does in a stack.
 *
 * An app with no environment of its own has nothing to copy, so it gets an
 * empty one — a non-null id IS the staging on-switch, so there must be a row.
 */
export function resolveStagingEnvironment(
  ctx: Pick<OpContext<DeployInput>, "log">,
  req: DeployInput,
  appId: number,
): number | null {
  if (req.webhook_staging_environment_id != null) return req.webhook_staging_environment_id;
  if (!req.webhook_staging) return null;

  let envName = `${req.app_name}-staging-env`;
  let suffix = 1;
  while (db.getEnvironments().find((e) => e.name === envName)) {
    envName = `${req.app_name}-staging-env-${suffix++}`;
  }
  const source = db.getApp(appId)?.environment_id ?? null;
  const created = source != null
    ? db.duplicateEnvironment(source, envName)
    : db.insertEnvironment(envName, "");
  ctx.log(
    source != null
      ? `created staging environment "${envName}" (${created.id}) as a copy of the app's environment`
      : `created empty staging environment "${envName}" (${created.id}) — the app has no environment to copy`,
  );
  return created.id;
}

const setupGithubWebhook: Step<DeployInput, { ok: boolean; error?: string; webhookId?: string }> = {
  name: "setup_github_webhook",
  label: "Configure webhook",
  async probe(ctx, prior) {
    const req = ctx.input;
    if (!req.webhook_enabled) return null;
    const appOut = prior["insert_app_row"] as InsertAppOut | undefined;
    if (!appOut) return null;
    const app = db.getApp(appOut.appId);
    if (!app || !app.github_webhook_id) return null;
    ctx.log(`adopting existing github webhook id=${app.github_webhook_id}`);
    return { ok: true, webhookId: app.github_webhook_id };
  },
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.webhook_enabled) return { ok: true };
    const appOut = prior["insert_app_row"] as InsertAppOut;

    const { githubPat } = await buildMasker(req, ctx.triggeredBy);
    if (!githubPat) return { ok: false, error: "No GitHub token" };

    try {
      const panel = db.getPanel();
      if (!panel?.domain) throw new Error("Panel domain is not set; cannot register webhook URL");
      const webhookBranch = req.webhook_branch || "main";
      const webhookPath = (req.webhook_path || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
      const webhookSecret = crypto.randomUUID();
      const url = `https://${panel.domain}/webhooks/github/${appOut.appId}`;
      const created = await github.createWebhookAtUrl({
        gitRepo: req.git_repo,
        url,
        webhookSecret,
        token: githubPat,
      });
      db.updateAppWebhook(
        appOut.appId,
        true,
        webhookSecret,
        webhookBranch,
        String(created.id),
        webhookPath,
        !!req.webhook_wait_for_ci,
      );
      db.appendDeployLog(appOut.appId, `[webhook] Auto-redeploy enabled on branch ${webhookBranch}`);
      const stagingEnvId = resolveStagingEnvironment(ctx, req, appOut.appId);
      if (stagingEnvId != null) {
        db.updateAppWebhookStagingEnvironment(appOut.appId, stagingEnvId);
        db.appendDeployLog(appOut.appId, `[webhook] Staging enabled — pushes hold in ${req.app_name}-staging for manual promotion`);
      }
      return { ok: true, webhookId: String(created.id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.appendDeployLog(appOut.appId, `[webhook] Warning: failed to set up webhook: ${msg}`);
      ctx.log(`Webhook setup failed (non-fatal): ${msg}`);
      return { ok: false, error: msg };
    }
  },
  async compensate(ctx, out) {
    const webhookId = (out as { webhookId?: string } | null)?.webhookId;
    if (!webhookId) return;
    const req = ctx.input;
    const { githubPat } = await buildMasker(req, ctx.triggeredBy);
    if (!githubPat) return;
    // Deliberately best-effort: webhook setup is a non-fatal forward step (it
    // returns ok:false instead of throwing), and GitHub's DELETE is NOT
    // idempotent — a resumed compensate would 404 on an already-deleted hook
    // and falsely escalate. A stray webhook is low-stakes (it targets a deleted
    // app's endpoint), so we don't block the rollback on it.
    try {
      await github.deleteWebhook({ gitRepo: req.git_repo, webhookId, token: githubPat });
    } catch (err) {
      ctx.log(`Failed to delete webhook ${webhookId}: ${err}`);
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
    const { minReplicas: durFloor, desiredReplicas: desired } = resolveDurability(
      req.durability_class,
      req.replicas,
    );
    if (req.replicas && req.replicas > 1 && !(req.public !== false && !appOut.domain)) {
      db.updateAppScaling(appOut.appId, {
        desired_replicas: desired,
        min_replicas: durFloor,
        max_replicas: desired,
      });
      db.appendDeployLog(appOut.appId, `[scale] Target ${desired} replicas — reconciler will converge`);
    }
    if (req.manifest_path && req.manifest_hash) {
      db.recordAppManifestApplied(appOut.appId, req.manifest_path, req.manifest_hash);
    }
    const deployment = prior["record_deployment_history"] as { deploymentId: number } | undefined;
    const finalRevision = db.getApp(appOut.appId)?.config_revision;
    if (deployment && finalRevision != null) {
      db.updateDeploymentConfigRevision(deployment.deploymentId, finalRevision);
    }

    db.appendDeployLog(appOut.appId, `[done] App deployed successfully`);
    if (ctx.triggeredBy) {
      try { db.deleteDeploySession(ctx.triggeredBy); } catch { /* best-effort */ }
    }
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
    createDnsRecord,
    createVolume,
    insertAppRow,
    setupVolumeBindMount,
    cloneRepoStep,
    buildAndRunContainer,
    syncIngressStep,
    healthCheckStep,
    recordDeploymentHistory,
    setupGithubWebhook,
    finalizeDeploy,
  ],
};

registerOp(deployOp as OpKindDefinition<any>);

export default deployOp;
export type { DeployInput };
