import type { DeployRequest, Server } from "../../shared/rpc.ts";
import dbInstance, * as db from "../../shared/db.ts";
import { getComputeProvider, getDnsProvider } from "../../shared/providers/index.ts";
import {
  sshExec,
  cloneRepo,
  cloneAndBuild,
  cloneAndComposeBuild,
  detectComposeFile,
  detectWebService,
  removeContainer,
  removeCompose,
  healthCheck,
  composeHealthCheck,
  deployAuthProxy,
  removeAuthProxy,
  containerExists,
  composeProjectExists,
} from "../../shared/remote/index.ts";
import { syncAppCaddy, removeAppCaddy } from "../scale/caddy-manager.ts";
import { replicaBindHost } from "../scale/types.ts";
import * as github from "../../shared/github.ts";
import { validateDeployRequest, assertSafeHostPath } from "../../shared/validate.ts";
import { createMasker } from "../../shared/mask.ts";
import { processIncomingEnvVars, serializeEnvVars } from "../../shared/env-crypto.ts";
import { getProviderToken } from "../../shared/secret-store.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { provisionServer } from "../provision-server.ts";
import { resolve4 } from "node:dns/promises";
import { registerOp } from "./registry.ts";
import {
  enqueueOperation,
  listChildOperations,
  requestCancel,
  type OperationStatus,
} from "../../shared/db/operations.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";

type DeployInput = DeployRequest;

type ServerOut = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
  provisioned: boolean;
  providerServerId?: string;
  ingressIp: string;
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
  deployMode: "dockerfile" | "compose";
  imageTag: string;
  composeFile: string;
  composeWebService: string;
};

type AuthProxyOut = { caddyPort: number } | null;

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
  const compute = getComputeProvider();
  if (!compute.volumes) return null;
  if (compute.volumes.findByName) return compute.volumes.findByName(name);
  // Fallback: filter the full list.
  try {
    const all = await compute.volumes.list();
    return all.find((v) => v.name === name) ?? null;
  } catch {
    return null;
  }
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
    const existingReady = db.getServers().find((s: Server) => s.status === "ready");
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
    const settings = db.getSettings();
    const dnsZoneId = settings.dns_zone_id;
    if (!req.domain || !dnsZoneId) return null;

    const parts = req.domain.split(".");
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

    // Idempotency: check provider for existing record.
    const dns = getDnsProvider();
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
    try {
      const dns = getDnsProvider();
      await dns.deleteRecord({
        zoneId: out.zoneId,
        name: out.name,
        type: out.type,
        value: out.value,
      });
    } catch (err) {
      ctx.log(`Failed to delete DNS record: ${err}`);
    }
  },
};

const createVolume: Step<DeployInput, VolumeOut> = {
  name: "create_volume",
  label: "Create volume",
  async probe(ctx) {
    const req = ctx.input;
    if (!req.volume_size || req.volume_size <= 0) return null;
    const volName = `ocd-${req.app_name}-data`;
    const existing = await findVolumeByName(volName);
    if (!existing) return null;
    const hostMountPath = `/mnt/ocd-${req.app_name}-data`;
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
    try {
      const compute = getComputeProvider();
      if (!compute.volumes) return true;
      await compute.volumes.get(out.volumeId);
      return false;
    } catch {
      return true;
    }
  },
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.volume_size || req.volume_size <= 0) return null;

    const server = prior["pick_or_provision_server"] as ServerOut;
    const settings = db.getSettings();
    const compute = getComputeProvider();
    if (!compute.volumes) {
      throw new Error(`Provider "${compute.name}" does not support managed volumes`);
    }

    let providerServerId = server.providerServerId;
    if (!providerServerId) {
      const existingServer = db.getServer(server.serverId);
      if (!existingServer) throw new Error(`Server ${server.serverId} not found`);
      providerServerId = existingServer.provider_id;
    }

    const vol = await compute.volumes.create({
      name: `ocd-${req.app_name}-data`,
      sizeGb: req.volume_size,
      serverId: providerServerId,
      location: settings.default_location || "nbg1",
    });
    const hostMountPath = `/mnt/ocd-${req.app_name}-data`;
    const containerPath = req.volume_path || "/data";
    // Host bind-mount setup happens in a later step (setup_volume_bind_mount)
    // once we have an app.id to tag the fstab block with. For non-Hetzner
    // providers we still need the directory to exist before docker run.
    if (compute.id !== "hetzner") {
      await sshExec(
        server.serverIp,
        `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`,
        server.serverHostKey || undefined,
      );
    }
    ctx.log(`Volume ready (${req.volume_size}GB at ${containerPath})`);
    return {
      volumeId: vol.providerId,
      volumeMount: `${hostMountPath}:${containerPath}`,
      containerPath,
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
    const useDomain = existing.domain || `${req.app_name}.${server.ingressIp}.nip.io`;
    const useInternalTls = !req.domain;
    const dockerfilePath = existing.dockerfile_path || req.dockerfile_path || "Dockerfile";

    // Resolve flat env vars from the existing app's environment (idempotent).
    const flatEnvVars: Record<string, string> = {};
    if (existing.environment_id) {
      const envRow = db.getEnvironment(existing.environment_id);
      if (envRow) {
        const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
        Object.assign(flatEnvVars, await resolveEnvVarsForDeploy(envRow.env_vars));
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

    const useDomain = req.domain || `${req.app_name}.${server.ingressIp}.nip.io`;
    const useInternalTls = !req.domain;
    const dockerfilePath = req.dockerfile_path || "Dockerfile";

    // Resolve environment + flat env vars (must be reproducible; idempotent
    // env creation uses unique-name retry).
    let environmentId: number | null = req.environment_id ?? null;
    const flatEnvVars: Record<string, string> = {};

    if (environmentId) {
      const envRow = db.getEnvironment(environmentId);
      if (envRow) {
        const { resolveEnvVarsForDeploy } = await import("../../shared/env-crypto.ts");
        Object.assign(flatEnvVars, await resolveEnvVarsForDeploy(envRow.env_vars));
      }
    } else if (
      req.env_vars &&
      (Array.isArray(req.env_vars) ? req.env_vars.length > 0 : Object.keys(req.env_vars).length > 0)
    ) {
      const processedEnv = await processIncomingEnvVars(req.env_vars);
      const rawEntries = Array.isArray(req.env_vars)
        ? req.env_vars
        : Object.entries(req.env_vars).map(([k, v]) => ({ key: k, value: v as string }));
      for (const e of rawEntries) flatEnvVars[e.key] = e.value;

      let envName = req.app_name;
      let suffix = 1;
      while (db.getEnvironments().find((e) => e.name === envName)) {
        envName = `${req.app_name}-${suffix++}`;
      }
      const envRow = db.insertEnvironment(envName, serializeEnvVars(processedEnv.entries));
      environmentId = envRow.id;
    }

    const extraVolumes = (req.extra_volumes || []).map(
      (v) => `${v.host_path}:${v.container_path}`,
    );
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
          public: req.public,
        },
        server.serverId,
      );
      if (ctx.triggeredBy) db.updateAppDeployedBy(result.app.id, ctx.triggeredBy);
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
      flatEnvVars,
      dockerfilePath,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try { db.deleteReplica(out.replicaId); } catch (err) {
      ctx.log(`Failed to delete replica ${out.replicaId}: ${err}`);
    }
    try { db.deleteApp(out.appId); } catch (err) {
      ctx.log(`Failed to delete app ${out.appId}: ${err}`);
    }
  },
};

const setupVolumeBindMount: Step<DeployInput, { ok: true }> = {
  name: "setup_volume_bind_mount",
  label: "Bind volume mount",
  async run(ctx, prior) {
    const volume = prior["create_volume"] as VolumeOut;
    if (!volume) return { ok: true };
    const compute = getComputeProvider();
    if (compute.id !== "hetzner") return { ok: true };
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
    const compute = getComputeProvider();
    if (compute.id !== "hetzner") return;
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
    }, req.git_branch);
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
    // Probe both deploy modes; whichever the prior run used will hit.
    if (await composeProjectExists(server.serverIp, req.app_name, hostKey)) {
      const composeFile = req.compose_file
        || await detectComposeFile(server.serverIp, req.app_name, hostKey)
        || "docker-compose.yml";
      const composeWebService = req.compose_web_service
        || await detectWebService(server.serverIp, req.app_name, composeFile, hostKey)
        || "web";
      const stillRunning = await containerExists(server.serverIp, req.app_name, hostKey);
      if (stillRunning) {
        ctx.log(`adopting existing compose project ${req.app_name}`);
        return {
          deployMode: "compose",
          imageTag: `${req.app_name}:latest`,
          composeFile,
          composeWebService,
        };
      }
    }
    if (await containerExists(server.serverIp, req.app_name, hostKey)) {
      ctx.log(`adopting existing container ${req.app_name}`);
      return {
        deployMode: "dockerfile",
        imageTag: `${req.app_name}:latest`,
        composeFile: "",
        composeWebService: "",
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

    let deployMode: "dockerfile" | "compose" = "dockerfile";
    let composeFile = "";
    let composeWebService = "";

    if (!req.dockerfile_path) {
      const detected = req.compose_file
        || await detectComposeFile(server.serverIp, req.app_name, server.serverHostKey || undefined);
      if (detected) {
        deployMode = "compose";
        composeFile = detected;
        composeWebService = req.compose_web_service ||
          await detectWebService(server.serverIp, req.app_name, detected, server.serverHostKey || undefined) ||
          "web";
      }
    }

    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    let imageTag = `${req.app_name}:latest`;
    if (deployMode === "compose") {
      const result = await cloneAndComposeBuild(
        server.serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          hostPort: appOut.hostPort,
          envVars: appOut.flatEnvVars,
          volumeMount: volume?.volumeMount,
          extraVolumes: (req.extra_volumes || []).map((v) => `${v.host_path}:${v.container_path}`),
          composeFile,
          webService: composeWebService,
          gitToken: githubPat,
          gitBranch: req.git_branch,
          bindAddr: containerBindAddr,
          skipClone: true,
        },
        (line) => {
          maskedLog(`[build] ${line}`);
          ctx.log(`[build] ${mask(line)}`);
        },
      );
      db.updateAppDeployMode(appOut.appId, "compose", result.composeFile, result.webService);
      composeFile = result.composeFile;
      composeWebService = result.webService;
    } else {
      const result = await cloneAndBuild(
        server.serverIp,
        {
          name: req.app_name,
          gitRepo: req.git_repo,
          port: req.container_port,
          hostPort: appOut.hostPort,
          envVars: appOut.flatEnvVars,
          volumeMount: volume?.volumeMount,
          extraVolumes: (req.extra_volumes || []).map((v) => `${v.host_path}:${v.container_path}`),
          dockerfilePath: req.dockerfile_path,
          dockerContext: req.docker_context,
          gitToken: githubPat,
          gitBranch: req.git_branch,
          bindAddr: containerBindAddr,
          skipClone: true,
          memoryMb: req.memory_mb || undefined,
        },
        (line) => {
          maskedLog(`[build] ${line}`);
          ctx.log(`[build] ${mask(line)}`);
        },
      );
      if (result.imageTag) imageTag = result.imageTag;
    }

    return { deployMode, imageTag, composeFile, composeWebService };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!server || !appOut) return;
    try {
      if (out.deployMode === "compose") {
        await removeCompose(server.serverIp, appOut.containerName, false, server.serverHostKey || undefined);
      } else {
        await removeContainer(server.serverIp, appOut.containerName, server.serverHostKey || undefined);
      }
    } catch (err) {
      ctx.log(`Failed to remove container: ${err}`);
    }
  },
};

const deployAuthProxyStep: Step<DeployInput, AuthProxyOut> = {
  name: "deploy_auth_proxy",
  label: "Deploy auth proxy",
  async probe(ctx, prior) {
    const req = ctx.input;
    if (!req.auth_password) return null;
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return null;
    const { authProxyPort } = await import("../../shared/remote/index.ts");
    const proxyName = `${req.app_name}-auth`;
    const exists = await containerExists(server.serverIp, proxyName, server.serverHostKey || undefined);
    if (!exists) return null;
    const appOut = prior["insert_app_row"] as InsertAppOut | undefined;
    const caddyPort = authProxyPort(appOut?.hostPort ?? 0);
    ctx.log(`adopting existing auth proxy container ${proxyName}`);
    return { caddyPort };
  },
  async probeCompensated(ctx, _out, prior) {
    const server = prior["pick_or_provision_server"] as ServerOut | undefined;
    if (!server) return true;
    const exists = await containerExists(server.serverIp, `${ctx.input.app_name}-auth`, server.serverHostKey || undefined);
    return !exists;
  },
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.auth_password) return null;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);
    const caddyPort = await deployAuthProxy(
      server.serverIp,
      req.app_name,
      req.auth_password,
      appOut.hostPort,
      containerBindAddr,
      server.serverHostKey || undefined,
    );
    db.appendDeployLog(appOut.appId, `[auth] Auth proxy deployed on port ${caddyPort}`);
    return { caddyPort };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const req = ctx.input;
    if (!server) return;
    try {
      await removeAuthProxy(server.serverIp, req.app_name, server.serverHostKey || undefined);
    } catch (err) {
      ctx.log(`Failed to remove auth proxy: ${err}`);
    }
  },
};

const syncCaddyStep: Step<DeployInput, { domain: string }> = {
  name: "sync_caddy",
  label: "Configure Caddy",
  async run(ctx, prior) {
    const req = ctx.input;
    const server = prior["pick_or_provision_server"] as ServerOut;
    const dns = prior["create_dns_record"] as DnsOut;
    const appOut = prior["insert_app_row"] as InsertAppOut;

    if (req.domain && !appOut.useInternalTls && !dns) {
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

    await syncAppCaddy(appOut.appId);
    db.appendDeployLog(appOut.appId, `[caddy] Panel ingress configured for ${appOut.domain}`);
    return { domain: appOut.domain };
  },
  async compensate(ctx, out, prior) {
    if (!out) return;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!appOut) return;
    try {
      await removeAppCaddy(appOut.containerName, out.domain);
    } catch (err) {
      ctx.log(`Failed to remove Caddy site: ${err}`);
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
    const build = prior["build_and_run_container"] as BuildOut;
    const tenantServerRow = db.getServer(server.serverId);
    if (!tenantServerRow) throw new Error(`Server ${server.serverId} not found`);
    const containerBindAddr = replicaBindHost(tenantServerRow);

    const health = build.deployMode === "compose"
      ? await composeHealthCheck(server.serverIp, req.app_name, containerBindAddr, appOut.hostPort, 5, server.serverHostKey || undefined)
      : await healthCheck(server.serverIp, req.app_name, containerBindAddr, appOut.hostPort, 5, server.serverHostKey || undefined);

    if (health.healthy) {
      db.appendDeployLog(appOut.appId, `[health] Health check passed (HTTP ${health.statusCode})`);
      db.updateAppStatus(appOut.appId, "running");
      db.updateReplicaStatus(appOut.replicaId, "running");
    } else {
      // Soft failure: record but don't throw.
      db.appendDeployLog(appOut.appId, `[health] ${health.error || "Health check failed"}`);
      db.updateAppStatus(appOut.appId, "unhealthy");
      db.updateReplicaStatus(appOut.replicaId, "unhealthy");
      ctx.log(`Warning: ${health.error || "Health check failed"} — app may still be starting`);
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
    });
    return { deploymentId: row.id, gitCommit };
  },
  async compensate(ctx, out) {
    if (!out) return;
    try {
      dbInstance.run("DELETE FROM deployment_history WHERE id = ?", [out.deploymentId]);
    } catch (err) {
      ctx.log(`Failed to delete deployment history row ${out.deploymentId}: ${err}`);
    }
  },
};

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
    try {
      await github.deleteWebhook({ gitRepo: req.git_repo, webhookId, token: githubPat });
    } catch (err) {
      ctx.log(`Failed to delete webhook ${webhookId}: ${err}`);
    }
  },
};

const TERMINAL: ReadonlySet<OperationStatus> = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
]);

const enqueueScaleChild: Step<DeployInput, { childOpId: number | null }> = {
  name: "enqueue_scale_child",
  label: "Enqueue scale",
  async run(ctx, prior) {
    const req = ctx.input;
    const appOut = prior["insert_app_row"] as InsertAppOut;
    if (!req.replicas || req.replicas <= 1 || !req.domain) {
      return { childOpId: null };
    }
    db.updateAppScaling(appOut.appId, {
      desired_replicas: req.replicas,
      min_replicas: 1,
      max_replicas: req.replicas,
    });

    const key = `deploy:${ctx.opId}:scale`;
    const existing = listChildOperations(ctx.opId).find((c) => c.idempotency_key === key);
    if (existing) return { childOpId: existing.id };

    const row = enqueueOperation({
      kind: "scale_up",
      resourceKeys: [`app:${appOut.appId}`],
      input: { appId: appOut.appId, targetReplicas: req.replicas },
      trigger: "deploy",
      triggeredBy: ctx.triggeredBy,
      parentId: ctx.opId,
      idempotencyKey: key,
    });
    return { childOpId: row.id };
  },
};

const waitForScale: Step<DeployInput, { ok: true }> = {
  name: "wait_for_scale",
  label: "Wait for scale",
  async run(ctx, prior) {
    const enq = prior["enqueue_scale_child"] as { childOpId: number | null };
    const appOut = prior["insert_app_row"] as InsertAppOut;

    if (enq.childOpId != null) {
      ctx.park();
      try {
        while (true) {
          const children = listChildOperations(ctx.opId);
          const child = children.find((c) => c.id === enq.childOpId);
          if (ctx.isCancelRequested()) {
            if (child && !TERMINAL.has(child.status)) {
              try { requestCancel(child.id); } catch { /* best-effort */ }
            }
            throw new Error("deploy cancelled");
          }
          if (child && TERMINAL.has(child.status)) {
            if (child.status !== "done") {
              // Treat scaling as best-effort: surface the warning but don't
              // fail the parent deploy (mirrors the previous inline behavior).
              db.appendDeployLog(appOut.appId, `[scale] Warning: scaling did not complete (status=${child.status})`);
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } finally {
        ctx.unpark();
      }
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
    deployAuthProxyStep,
    syncCaddyStep,
    healthCheckStep,
    recordDeploymentHistory,
    setupGithubWebhook,
    enqueueScaleChild,
    waitForScale,
  ],
};

registerOp(deployOp as OpKindDefinition<any>);

export default deployOp;
export type { DeployInput };
