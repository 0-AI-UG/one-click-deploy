import * as db from "./db.ts";
import type { AppRow } from "./db/apps.ts";
import type { DeployRequest } from "./rpc.ts";
import { parseEnvVars, processIncomingEnvVars, serializeEnvVars } from "./env-crypto.ts";
import { resolveDurability } from "./durability.ts";
import { validateDeployRequest } from "./validate.ts";
import * as github from "./github.ts";
import { resolveGitHubToken } from "./github-token.ts";

export type AppConfigChange = {
  field: string;
  before: unknown;
  after: unknown;
};

/** Build a full deploy request from an existing app row and a partial patch.
 *
 * This lets callers send only changed fields from the UI while preserving the
 * current stored manifest values for everything else.
 */
export function mergeDeployRequestWithExistingApp(
  app: AppRow,
  patch: Partial<DeployRequest> & { dry_run?: boolean; deploy?: boolean },
): DeployRequest {
  const merged: DeployRequest = {
    app_name: patch.app_name ?? app.name,
    domain: patch.domain ?? app.domain,
    git_repo: patch.git_repo ?? app.git_repo,
    git_branch: patch.git_branch ?? app.git_branch,
    dockerfile_path: patch.dockerfile_path ?? app.dockerfile_path || "Dockerfile",
    docker_context: patch.docker_context ?? app.docker_context || ".",
    image_ref: patch.image_ref ?? app.image_ref || "",
    build_cache_ref: patch.build_cache_ref ?? app.build_cache_ref || "",
    container_port: patch.container_port ?? app.container_port,
    env_vars: patch.env_vars,
    env_projection: patch.env_projection !== undefined ? patch.env_projection : db.parseAppEnvProjection(app),
    public: patch.public !== undefined ? patch.public : !!app.public,
    memory_mb: patch.memory_mb ?? (app.memory_mb ?? 0),
    cpu_limit: patch.cpu_limit ?? (app.cpu_limit ?? 0),
    auth_password: patch.auth_password,
    health_check: patch.health_check ?? !!app.health_check,
    health_check_mode: patch.health_check_mode ?? (app.health_check_mode || (app.health_check ? "http" : "container")),
    health_check_command: patch.health_check_command ?? app.health_check_command,
    health_check_file: patch.health_check_file ?? app.health_check_file,
    health_check_max_age_seconds: patch.health_check_max_age_seconds ?? app.health_check_max_age_seconds,
    environment_id: patch.environment_id ?? app.environment_id,
    webhook_enabled: patch.webhook_enabled ?? !!app.webhook_enabled,
    webhook_branch: patch.webhook_branch ?? app.webhook_branch || "main",
    webhook_path: patch.webhook_path ?? app.webhook_path,
    webhook_wait_for_ci: patch.webhook_wait_for_ci ?? !!app.webhook_wait_for_ci,
    internal_protocol: patch.internal_protocol ?? (app.internal_protocol || "http"),
    sticky: patch.sticky ?? !!app.sticky,
    rate_limit_rps: patch.rate_limit_rps ?? app.rate_limit_rps,
    ip_allowlist: patch.ip_allowlist ?? app.ip_allowlist,
    health_check_path: patch.health_check_path ?? app.health_check_path,
    compress: patch.compress ?? !!app.compress,
    public_port: patch.public_port !== undefined ? patch.public_port : app.public_port ?? null,
    public_protocol: patch.public_protocol ?? ((app.public_protocol as "tcp" | "udp") || "tcp"),
    placement_pool: patch.placement_pool ?? app.placement_pool,
    durability_class: patch.durability_class ?? app.durability_class,
    max_per_host: patch.max_per_host ?? app.max_per_host,
    min_locations: patch.min_locations ?? app.min_locations,
    desired_replicas: patch.desired_replicas ?? app.desired_replicas,
    min_replicas: patch.min_replicas ?? app.min_replicas,
    max_replicas: patch.max_replicas ?? app.max_replicas,
    scale_to_zero_after: patch.scale_to_zero_after ?? app.scale_to_zero_after,
    target: patch.target ?? app.target,
    target_of: patch.target_of ?? app.target_of,
    volume_size: patch.volume_size,
    volume_path: patch.volume_path,
  };
  if (patch.webhook_staging !== undefined) {
    merged.webhook_staging = patch.webhook_staging;
  }
  if (patch.webhook_staging_environment_id !== undefined) {
    merged.webhook_staging_environment_id = patch.webhook_staging_environment_id;
  }
  return merged;
}

function normalizedSpec(req: DeployRequest) {
  const durability = resolveDurability(req.durability_class, req.replicas);
  return {
    git_repo: req.git_repo,
    git_branch: req.git_branch ?? "",
    dockerfile_path: req.dockerfile_path ?? "Dockerfile",
    docker_context: req.docker_context ?? ".",
    image_ref: req.image_ref ?? "",
    build_cache_ref: req.build_cache_ref ?? "",
    container_port: req.container_port,
    environment_id: req.environment_id,
    env_projection: req.env_projection ?? null,
    public: req.public ?? true,
    memory_mb: req.memory_mb ?? 0,
    cpu_limit: req.cpu_limit ?? 0,
    health_check: req.health_check_mode ? req.health_check_mode === "http" : (req.health_check ?? true),
    health_check_mode: req.health_check_mode ?? (req.health_check === false ? "container" : "http"),
    health_check_command: req.health_check_command ?? "",
    health_check_file: req.health_check_file ?? "",
    health_check_max_age_seconds: req.health_check_max_age_seconds ?? 0,
    internal_protocol: req.internal_protocol ?? "http",
    sticky: req.sticky ?? false,
    rate_limit_rps: req.rate_limit_rps ?? 0,
    ip_allowlist: req.ip_allowlist ?? "",
    health_check_path: req.health_check_path ?? "",
    compress: req.compress ?? false,
    public_port: req.public_port ?? null,
    public_protocol: req.public_protocol ?? "tcp",
    desired_replicas: durability.desiredReplicas,
    min_replicas: durability.minReplicas,
    max_replicas: Math.max(durability.desiredReplicas, durability.minReplicas),
    durability_class: durability.durabilityClass,
    max_per_host: durability.maxPerHost,
    min_locations: durability.minLocations,
    placement_pool: req.placement_pool ?? "general",
    scale_to_zero_after: req.scale_to_zero_after ?? 0,
    extra_volumes: (req.extra_volumes ?? []).map((v) => `${v.host_path}:${v.container_path}`),
    webhook_enabled: req.webhook_enabled ?? false,
    webhook_branch: req.webhook_branch ?? "main",
    webhook_path: (req.webhook_path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, ""),
    webhook_wait_for_ci: req.webhook_wait_for_ci ?? false,
  };
}

function comparableApp(app: AppRow) {
  return {
    git_repo: app.git_repo,
    git_branch: app.git_branch || "",
    dockerfile_path: app.dockerfile_path || "Dockerfile",
    docker_context: app.docker_context || ".",
    image_ref: app.image_ref || "",
    build_cache_ref: app.build_cache_ref || "",
    container_port: app.container_port,
    environment_id: app.environment_id,
    env_projection: db.parseAppEnvProjection(app),
    public: !!app.public,
    memory_mb: app.memory_mb ?? 0,
    cpu_limit: app.cpu_limit ?? 0,
    health_check: !!app.health_check,
    health_check_mode: app.health_check_mode || (app.health_check ? "http" : "container"),
    health_check_command: app.health_check_command || "",
    health_check_file: app.health_check_file || "",
    health_check_max_age_seconds: app.health_check_max_age_seconds || 0,
    internal_protocol: app.internal_protocol || "http",
    sticky: !!app.sticky,
    rate_limit_rps: app.rate_limit_rps ?? 0,
    ip_allowlist: app.ip_allowlist || "",
    health_check_path: app.health_check_path || "",
    compress: !!app.compress,
    public_port: app.public_port,
    public_protocol: app.public_protocol || "tcp",
    desired_replicas: app.desired_replicas,
    min_replicas: app.min_replicas,
    max_replicas: app.max_replicas,
    durability_class: app.durability_class || "none",
    max_per_host: app.max_per_host,
    min_locations: app.min_locations,
    placement_pool: app.placement_pool || "general",
    scale_to_zero_after: app.scale_to_zero_after ?? 0,
    extra_volumes: db.parseExtraVolumes(app.extra_volumes),
    webhook_enabled: !!app.webhook_enabled,
    webhook_branch: app.webhook_branch || "main",
    webhook_path: app.webhook_path || "",
    webhook_wait_for_ci: !!app.webhook_wait_for_ci,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Diff an explicit manifest/API spec against OCD's currently stored desired
 * configuration. Secrets are intentionally absent from the diff. */
export function diffAppConfig(app: AppRow, req: DeployRequest): AppConfigChange[] {
  const before = comparableApp(app) as Record<string, unknown>;
  const after = normalizedSpec(req) as Record<string, unknown>;
  const changes: AppConfigChange[] = [];
  for (const [field, value] of Object.entries(after)) {
    // Omitting environment_id means retain the currently linked environment;
    // manifests do not implicitly detach durable configuration.
    if (field === "environment_id" && value === undefined) continue;
    if (!sameValue(before[field], value)) {
      changes.push({ field, before: before[field], after: value });
    }
  }
  if (req.domain !== undefined && app.domain !== req.domain) {
    changes.push({ field: "domain", before: app.domain, after: req.domain });
  }
  return changes;
}

async function applyEnvironment(app: AppRow, req: DeployRequest): Promise<void> {
  if (req.environment_id !== undefined && req.environment_id !== app.environment_id) {
    if (!db.getEnvironment(req.environment_id)) throw new Error("Environment not found");
    db.updateAppEnvironment(app.id, req.environment_id);
  }
  if (!req.env_vars) return;
  const incoming = await processIncomingEnvVars(req.env_vars);
  if (incoming.entries.length === 0) return;
  const current = db.getApp(app.id);
  let env = current?.environment_id ? db.getEnvironment(current.environment_id) : null;
  if (!env) {
    let name = app.name;
    let suffix = 1;
    while (db.getEnvironments().some((e) => e.name === name)) name = `${app.name}-${suffix++}`;
    env = db.insertEnvironment(name, serializeEnvVars([]));
    db.updateAppEnvironment(app.id, env.id);
  }
  const incomingKeys = new Set(incoming.entries.map((e) => e.key));
  const retained = parseEnvVars(env.env_vars).entries.filter((e) => !incomingKeys.has(e.key));
  db.updateEnvironment(env.id, env.name, serializeEnvVars([...retained, ...incoming.entries]));
}

async function applyWebhook(
  app: AppRow,
  req: DeployRequest,
  userId?: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  const desired = normalizedSpec(req);
  const token = (await resolveGitHubToken(userId)) || undefined;
  if (!desired.webhook_enabled) {
    if (app.github_webhook_id && token) {
      try {
        await github.deleteWebhook({
          gitRepo: app.git_repo,
          webhookId: app.github_webhook_id,
          token,
        });
      } catch (err) {
        log(`warning: could not remove GitHub webhook ${app.github_webhook_id}: ${err}`);
      }
    }
    db.updateAppWebhook(app.id, false, "", desired.webhook_branch, "", desired.webhook_path, desired.webhook_wait_for_ci);
    db.updateAppWebhookStagingEnvironment(app.id, null);
    return;
  }

  let secret = app.webhook_secret;
  let webhookId = app.github_webhook_id;
  if (!webhookId) {
    if (!token) throw new Error("A linked GitHub account is required to enable the manifest webhook");
    const panel = db.getPanel();
    if (!panel?.domain) throw new Error("Panel domain is not set; cannot register webhook URL");
    secret = crypto.randomUUID();
    const created = await github.createWebhookAtUrl({
      gitRepo: req.git_repo,
      url: `https://${panel.domain}/webhooks/github/${app.id}`,
      webhookSecret: secret,
      token,
    });
    webhookId = String(created.id);
  }
  db.updateAppWebhook(
    app.id,
    true,
    secret,
    desired.webhook_branch,
    webhookId,
    desired.webhook_path,
    desired.webhook_wait_for_ci,
  );

  let stagingId = req.webhook_staging_environment_id;
  if (stagingId === undefined && req.webhook_staging) {
    stagingId = app.webhook_staging_environment_id;
    if (stagingId == null) {
      let name = `${app.name}-staging-env`;
      let suffix = 1;
      while (db.getEnvironments().some((e) => e.name === name)) {
        name = `${app.name}-staging-env-${suffix++}`;
      }
      const created = app.environment_id
        ? db.duplicateEnvironment(app.environment_id, name)
        : db.insertEnvironment(name, "");
      stagingId = created.id;
      log(`created staging environment "${name}" (${created.id})`);
    }
  }
  if (!req.webhook_staging && req.webhook_staging_environment_id === undefined) stagingId = null;
  if (stagingId != null && !db.getEnvironment(stagingId)) throw new Error("Staging environment not found");
  db.updateAppWebhookStagingEnvironment(app.id, stagingId ?? null);
}

/** Apply a complete normalized desired spec to an existing app. It never
 * deploys code and never deletes an environment; callers decide whether to
 * enqueue a rollout after the configuration transaction succeeds. */
export async function applyAppConfig(
  appId: number,
  req: DeployRequest,
  opts: { userId?: string; log?: (line: string) => void } = {},
): Promise<AppConfigChange[]> {
  const validation = validateDeployRequest(req);
  if (!validation.valid) throw new Error(validation.error);
  const app = db.getApp(appId);
  if (!app) throw new Error("App not found");
  if (req.app_name !== app.name) throw new Error(`Manifest targets "${req.app_name}", but app #${appId} is "${app.name}"`);
  if (req.volume_size && !app.volume_id) {
    throw new Error("Adding a persistent volume to an existing app is an explicit storage operation; use the Volumes UI first");
  }

  const desired = normalizedSpec(req);
  const changes = diffAppConfig(app, req);
  const changed = new Set(changes.map((c) => c.field));
  await applyEnvironment(app, req);
  if (["git_repo", "git_branch", "dockerfile_path", "docker_context"].some((f) => changed.has(f))) {
    db.updateAppBuildSource(app.id, {
      gitRepo: desired.git_repo,
      gitBranch: desired.git_branch,
      dockerfilePath: desired.dockerfile_path,
      dockerContext: desired.docker_context,
    });
  }
  if ([
    "image_ref", "build_cache_ref", "health_check_mode", "health_check_command",
    "health_check_file", "health_check_max_age_seconds",
  ].some((f) => changed.has(f))) {
    db.updateAppArtifactAndHealth(app.id, {
      imageRef: desired.image_ref,
      buildCacheRef: desired.build_cache_ref,
      healthMode: desired.health_check_mode,
      healthCommand: desired.health_check_command,
      healthFile: desired.health_check_file,
      healthMaxAgeSeconds: desired.health_check_max_age_seconds,
    });
  }
  if (changed.has("container_port")) db.updateAppContainerPort(app.id, desired.container_port);
  if (changed.has("domain") && req.domain !== undefined) db.updateAppDomain(app.id, req.domain);
  if (changed.has("env_projection")) db.updateAppEnvProjection(app.id, desired.env_projection);
  if (changed.has("public")) db.updateAppPublic(app.id, desired.public);
  if (changed.has("memory_mb")) db.updateAppMemory(app.id, desired.memory_mb);
  if (changed.has("cpu_limit")) db.updateAppCpu(app.id, desired.cpu_limit);
  if (changed.has("internal_protocol")) db.updateAppInternalProtocol(app.id, desired.internal_protocol);
  if (["sticky", "rate_limit_rps", "ip_allowlist", "health_check_path", "compress", "health_check"].some((f) => changed.has(f))) {
    db.updateAppIngressSettings(app.id, {
      sticky: desired.sticky,
      rate_limit_rps: desired.rate_limit_rps,
      ip_allowlist: desired.ip_allowlist,
      health_check_path: desired.health_check_path,
      compress: desired.compress,
      health_check: desired.health_check,
    });
  }
  if (req.auth_password !== undefined) db.updateAppAuthPassword(app.id, req.auth_password);
  if (changed.has("public_port") || changed.has("public_protocol")) {
    if (desired.public_port == null) {
      db.updateAppPublicExposure(app.id, null, desired.public_protocol);
    } else if (desired.public_port === "auto") {
      const current = db.getApp(app.id)!;
      const port = current.public_port != null && current.public_protocol === desired.public_protocol
        ? current.public_port
        : db.allocatePublicPort(desired.public_protocol);
      db.updateAppPublicExposure(app.id, port, desired.public_protocol);
    } else {
      const holder = db.getAppByPublicPort(desired.public_port);
      if (holder && holder.id !== app.id) throw new Error(`Port ${desired.public_port} is already used by "${holder.name}"`);
      db.updateAppPublicExposure(app.id, desired.public_port, desired.public_protocol);
    }
  }
  if (changed.has("extra_volumes")) db.updateAppExtraVolumes(app.id, desired.extra_volumes);
  if (["durability_class", "max_per_host", "min_locations"].some((f) => changed.has(f))) {
    db.updateAppDurability(app.id, {
      durability_class: desired.durability_class,
      max_per_host: desired.max_per_host,
      min_locations: desired.min_locations,
    });
  }
  if (changed.has("placement_pool")) db.updateAppPlacementPool(app.id, desired.placement_pool);
  if (["desired_replicas", "min_replicas", "max_replicas", "scale_to_zero_after"].some((f) => changed.has(f))) {
    db.updateAppScaling(app.id, {
      desired_replicas: desired.desired_replicas,
      min_replicas: desired.min_replicas,
      max_replicas: desired.max_replicas,
      scale_to_zero_after: desired.scale_to_zero_after,
    });
  }
  if (
    ["webhook_enabled", "webhook_branch", "webhook_path", "webhook_wait_for_ci"].some((f) => changed.has(f)) ||
    req.webhook_staging !== undefined ||
    req.webhook_staging_environment_id !== undefined
  ) {
    await applyWebhook(db.getApp(app.id)!, req, opts.userId, opts.log);
  }
  if (req.manifest_path && req.manifest_hash) {
    db.recordAppManifestApplied(app.id, req.manifest_path, req.manifest_hash);
  }
  if (opts.userId) db.updateAppDeployedBy(app.id, opts.userId);
  return changes;
}
