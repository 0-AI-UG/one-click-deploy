import * as db from "./db.ts";
import type { AppRow } from "./db/apps.ts";
import type { DeployRequest } from "./rpc.ts";
import { parseEnvVars, processIncomingEnvVars, serializeEnvVars } from "./env-crypto.ts";
import { resolveDurability } from "./durability.ts";
import { validateDeployRequest } from "./validate.ts";

export type AppConfigChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export const AUTOSCALE_DEFAULTS = {
  enabled: false,
  minReplicas: 1,
  maxReplicas: 1,
  cpuThreshold: 80,
  memoryThreshold: 85,
  requestsPerMinute: 0,
  cooldownSeconds: 300,
} as const;

export type AppScalingSpec = {
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: boolean;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_req_threshold: number;
  autoscale_cooldown: number;
  scale_to_zero_after: number;
  durability_class: "none" | "standard" | "high";
  max_per_host: number;
  min_locations: number;
};

function isManifestApply(req: Partial<DeployRequest>): boolean {
  return req.apply_mode === "manifest" ||
    (req.apply_mode === undefined && !!req.manifest_hash);
}

function environmentIdByName(name: string): number {
  const normalized = name.trim().toLowerCase();
  const environment = db.getEnvironments().find((candidate) =>
    candidate.name.toLowerCase() === normalized
  );
  if (!environment) throw new Error(`Environment not found: ${name}`);
  return environment.id;
}

/** Resolve portable environment-name selectors before persistence/operations. */
export function resolveDeployRequestEnvironmentIds(req: DeployRequest): DeployRequest {
  const resolved = { ...req };
  if (resolved.environment_id === undefined && resolved.environment !== undefined) {
    resolved.environment_id = resolved.environment === null
      ? null
      : environmentIdByName(resolved.environment);
  }
  if (
    resolved.webhook_staging_environment_id === undefined &&
    resolved.webhook_staging_environment !== undefined
  ) {
    resolved.webhook_staging_environment_id =
      resolved.webhook_staging_environment === null
        ? null
        : environmentIdByName(resolved.webhook_staging_environment);
  }
  return resolved;
}

/** Resolve durability floors and autoscaling into the concrete stored policy. */
export function normalizeAppScaling(req: DeployRequest): AppScalingSpec {
  const durability = resolveDurability(req.durability_class, req.replicas);
  const durabilityFloor = durability.durabilityClass === "none"
    ? 0
    : durability.minReplicas;
  const minReplicas = Math.max(
    req.min_replicas ?? AUTOSCALE_DEFAULTS.minReplicas,
    durabilityFloor,
  );
  const desiredReplicas = Math.max(
    req.replicas ?? 1,
    durabilityFloor,
    minReplicas,
  );
  const maxReplicas = Math.max(
    req.max_replicas ?? Math.max(AUTOSCALE_DEFAULTS.maxReplicas, desiredReplicas),
    minReplicas,
    desiredReplicas,
  );
  return {
    desired_replicas: desiredReplicas,
    min_replicas: minReplicas,
    max_replicas: maxReplicas,
    autoscale_enabled: req.autoscale_enabled ?? AUTOSCALE_DEFAULTS.enabled,
    autoscale_cpu_threshold:
      req.autoscale_cpu_threshold ?? AUTOSCALE_DEFAULTS.cpuThreshold,
    autoscale_mem_threshold:
      req.autoscale_mem_threshold ?? AUTOSCALE_DEFAULTS.memoryThreshold,
    autoscale_req_threshold:
      req.autoscale_req_threshold ?? AUTOSCALE_DEFAULTS.requestsPerMinute,
    autoscale_cooldown:
      req.autoscale_cooldown ?? AUTOSCALE_DEFAULTS.cooldownSeconds,
    scale_to_zero_after: req.scale_to_zero_after ?? 0,
    durability_class: durability.durabilityClass,
    max_per_host: durability.maxPerHost,
    min_locations: durability.minLocations,
  };
}

/** Build a full deploy request from an existing app row and a partial patch.
 *
 * This lets callers send only changed fields from the UI while preserving the
 * current stored manifest values for everything else.
 */
export function mergeDeployRequestWithExistingApp(
  app: AppRow,
  patch: Partial<DeployRequest> & { dry_run?: boolean; deploy?: boolean },
): DeployRequest {
  const manifest = isManifestApply(patch);
  const supplied = resolveDeployRequestEnvironmentIds({
    ...patch,
    app_name: patch.app_name ?? app.name,
    git_repo: patch.git_repo ?? app.git_repo,
    container_port: patch.container_port ?? app.container_port,
  });
  const publicApp = supplied.public !== undefined
    ? supplied.public
    : manifest ? true : !!app.public;
  const merged: DeployRequest = {
    apply_mode: manifest ? "manifest" : "patch",
    app_name: supplied.app_name,
    domain: publicApp ? supplied.domain ?? app.domain : "",
    git_repo: supplied.git_repo,
    git_branch: supplied.git_branch ?? (manifest ? "" : app.git_branch),
    dockerfile_path: supplied.dockerfile_path ??
      (manifest ? "Dockerfile" : app.dockerfile_path || "Dockerfile"),
    docker_context: supplied.docker_context ??
      (manifest ? "." : app.docker_context || "."),
    image_ref: supplied.image_ref ?? (manifest ? "" : app.image_ref || ""),
    build_cache_ref: supplied.build_cache_ref ??
      (manifest ? "" : app.build_cache_ref || ""),
    container_port: supplied.container_port,
    env_vars: supplied.env_vars,
    env_projection: supplied.env_projection !== undefined
      ? supplied.env_projection
      : manifest ? null : db.parseAppEnvProjection(app),
    public: publicApp,
    memory_mb: supplied.memory_mb ?? (manifest ? 0 : app.memory_mb ?? 0),
    cpu_limit: supplied.cpu_limit ?? (manifest ? 0 : app.cpu_limit ?? 0),
    auth_password: supplied.auth_password ?? (manifest ? "" : undefined),
    health_check: supplied.health_check ??
      (manifest ? true : !!app.health_check),
    health_check_mode: supplied.health_check_mode ??
      (supplied.health_check !== undefined
        ? supplied.health_check ? "http" : "container"
        : manifest
          ? "http"
          : (app.health_check_mode as DeployRequest["health_check_mode"]) ||
            (app.health_check ? "http" : "container")),
    health_check_command: supplied.health_check_command ??
      (manifest ? "" : app.health_check_command),
    health_check_file: supplied.health_check_file ??
      (manifest ? "" : app.health_check_file),
    health_check_max_age_seconds: supplied.health_check_max_age_seconds ??
      (manifest ? 0 : app.health_check_max_age_seconds),
    environment: supplied.environment,
    environment_id: supplied.environment_id !== undefined
      ? supplied.environment_id
      : app.environment_id,
    webhook_enabled: supplied.webhook_enabled ??
      (manifest ? false : !!app.webhook_enabled),
    webhook_branch: supplied.webhook_branch ??
      (manifest ? "main" : app.webhook_branch || "main"),
    webhook_path: supplied.webhook_path ?? (manifest ? "" : app.webhook_path),
    webhook_wait_for_ci: supplied.webhook_wait_for_ci ??
      (manifest ? false : !!app.webhook_wait_for_ci),
    webhook_staging: supplied.webhook_staging ??
      (manifest ? false : app.webhook_staging_environment_id != null),
    webhook_staging_environment: supplied.webhook_staging_environment,
    webhook_staging_environment_id:
      supplied.webhook_staging_environment_id !== undefined
        ? supplied.webhook_staging_environment_id
        : supplied.webhook_staging === true
          ? undefined
          : manifest ? null : app.webhook_staging_environment_id,
    internal_protocol: supplied.internal_protocol ??
      (manifest ? "http" : ((app.internal_protocol as "http" | "tcp") || "http")),
    sticky: supplied.sticky ?? (manifest ? false : !!app.sticky),
    rate_limit_rps: supplied.rate_limit_rps ?? (manifest ? 0 : app.rate_limit_rps),
    ip_allowlist: supplied.ip_allowlist ?? (manifest ? "" : app.ip_allowlist),
    health_check_path: supplied.health_check_path ??
      (manifest ? "" : app.health_check_path),
    compress: supplied.compress ?? (manifest ? false : !!app.compress),
    public_port: supplied.public_port !== undefined
      ? supplied.public_port
      : manifest ? null : app.public_port ?? null,
    public_protocol: supplied.public_protocol ??
      (manifest ? "tcp" : ((app.public_protocol as "tcp" | "udp") || "tcp")),
    placement_pool: supplied.placement_pool ??
      (manifest ? "general" : app.placement_pool),
    durability_class: supplied.durability_class ??
      (manifest ? "none" : app.durability_class as "none" | "standard" | "high"),
    replicas: supplied.replicas ?? (manifest ? 1 : app.desired_replicas),
    min_replicas: supplied.min_replicas ?? (manifest ? 1 : app.min_replicas),
    max_replicas: supplied.max_replicas ?? (manifest ? 1 : app.max_replicas),
    autoscale_enabled: supplied.autoscale_enabled ??
      (manifest ? AUTOSCALE_DEFAULTS.enabled : !!app.autoscale_enabled),
    autoscale_cpu_threshold: supplied.autoscale_cpu_threshold ??
      (manifest ? AUTOSCALE_DEFAULTS.cpuThreshold : app.autoscale_cpu_threshold),
    autoscale_mem_threshold: supplied.autoscale_mem_threshold ??
      (manifest ? AUTOSCALE_DEFAULTS.memoryThreshold : app.autoscale_mem_threshold),
    autoscale_req_threshold: supplied.autoscale_req_threshold ??
      (manifest ? AUTOSCALE_DEFAULTS.requestsPerMinute : app.autoscale_req_threshold),
    autoscale_cooldown: supplied.autoscale_cooldown ??
      (manifest ? AUTOSCALE_DEFAULTS.cooldownSeconds : app.autoscale_cooldown),
    scale_to_zero_after: supplied.scale_to_zero_after ??
      (manifest ? 0 : app.scale_to_zero_after),
    extra_volumes: supplied.extra_volumes ??
      (manifest
        ? []
        : db.parseExtraVolumes(app.extra_volumes).map((mount) => {
            const separator = mount.indexOf(":");
            return {
              host_path: mount.slice(0, separator),
              container_path: mount.slice(separator + 1),
            };
          })),
    target: supplied.target ?? app.target,
    target_of: supplied.target_of ?? app.target_of ?? undefined,
    volume_size: supplied.volume_size,
    volume_path: supplied.volume_path,
    manifest_path: supplied.manifest_path,
    manifest_hash: supplied.manifest_hash,
  };
  return merged;
}

function normalizedSpec(req: DeployRequest) {
  const scaling = normalizeAppScaling(req);
  return {
    domain: req.domain ?? "",
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
    desired_replicas: scaling.desired_replicas,
    min_replicas: scaling.min_replicas,
    max_replicas: scaling.max_replicas,
    autoscale_enabled: scaling.autoscale_enabled,
    autoscale_cpu_threshold: scaling.autoscale_cpu_threshold,
    autoscale_mem_threshold: scaling.autoscale_mem_threshold,
    autoscale_req_threshold: scaling.autoscale_req_threshold,
    autoscale_cooldown: scaling.autoscale_cooldown,
    durability_class: scaling.durability_class,
    max_per_host: scaling.max_per_host,
    min_locations: scaling.min_locations,
    placement_pool: req.placement_pool ?? "general",
    scale_to_zero_after: scaling.scale_to_zero_after,
    extra_volumes: (req.extra_volumes ?? []).map((v) => `${v.host_path}:${v.container_path}`),
    webhook_enabled: req.webhook_enabled ?? false,
    webhook_branch: req.webhook_branch ?? "main",
    webhook_path: (req.webhook_path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, ""),
    webhook_wait_for_ci: req.webhook_wait_for_ci ?? false,
    webhook_staging_environment_id: req.webhook_staging_environment_id ?? null,
  };
}

function comparableApp(app: AppRow) {
  return {
    domain: app.domain || "",
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
    autoscale_enabled: !!app.autoscale_enabled,
    autoscale_cpu_threshold: app.autoscale_cpu_threshold,
    autoscale_mem_threshold: app.autoscale_mem_threshold,
    autoscale_req_threshold: app.autoscale_req_threshold,
    autoscale_cooldown: app.autoscale_cooldown,
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
    webhook_staging_environment_id: app.webhook_staging_environment_id,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Diff an explicit manifest/API spec against OCD's currently stored desired
 * configuration. Secrets are intentionally absent from the diff. */
export function diffAppConfig(app: AppRow, req: DeployRequest): AppConfigChange[] {
  const effective = mergeDeployRequestWithExistingApp(app, req);
  const before = comparableApp(app) as Record<string, unknown>;
  const after = normalizedSpec(effective) as Record<string, unknown>;
  const changes: AppConfigChange[] = [];
  for (const [field, value] of Object.entries(after)) {
    if (!sameValue(before[field], value)) {
      changes.push({ field, before: before[field], after: value });
    }
  }
  return changes;
}

async function applyEnvironment(app: AppRow, req: DeployRequest): Promise<void> {
  if (req.environment_id !== undefined && req.environment_id !== app.environment_id) {
    if (req.environment_id !== null && !db.getEnvironment(req.environment_id)) {
      throw new Error("Environment not found");
    }
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
  _userId?: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  const desired = normalizedSpec(req);
  if (!desired.webhook_enabled) {
    // Preserve the remote id until the webhook reconciler confirms deletion;
    // clearing it here would turn a transient GitHub failure into an orphan.
    db.updateAppWebhook(
      app.id,
      false,
      app.webhook_secret,
      desired.webhook_branch,
      app.github_webhook_id,
      desired.webhook_path,
      desired.webhook_wait_for_ci,
    );
    db.updateAppWebhookStagingEnvironment(app.id, null);
    return;
  }

  const secret = app.webhook_secret || crypto.randomUUID();
  db.updateAppWebhook(
    app.id,
    true,
    secret,
    desired.webhook_branch,
    app.github_webhook_id,
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
  log("webhook desired state recorded; provider reconciliation is asynchronous");
}

/** Apply a complete normalized desired spec to an existing app. It never
 * deploys code and never deletes an environment; callers decide whether to
 * enqueue a rollout after the configuration transaction succeeds. */
export async function applyAppConfig(
  appId: number,
  req: DeployRequest,
  opts: { userId?: string; log?: (line: string) => void } = {},
): Promise<AppConfigChange[]> {
  const app = db.getApp(appId);
  if (!app) throw new Error("App not found");
  const effective = mergeDeployRequestWithExistingApp(app, req);
  const effectiveValidation = validateDeployRequest(effective);
  if (!effectiveValidation.valid) throw new Error(effectiveValidation.error);
  if (effective.app_name !== app.name) throw new Error(`Manifest targets "${effective.app_name}", but app #${appId} is "${app.name}"`);
  if (effective.volume_size && !app.volume_id) {
    throw new Error("Adding a persistent volume to an existing app is an explicit storage operation; use the Volumes UI first");
  }
  const scaling = normalizeAppScaling(effective);
  if (app.volume_id && (scaling.desired_replicas > 1 || scaling.max_replicas > 1)) {
    throw new Error("Apps with persistent storage cannot have more than 1 replica");
  }

  const desired = normalizedSpec(effective);
  const changes = diffAppConfig(app, effective);
  const changed = new Set(changes.map((c) => c.field));
  await applyEnvironment(app, effective);
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
  if (effective.auth_password !== undefined) db.updateAppAuthPassword(app.id, effective.auth_password);
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
  if ([
    "desired_replicas", "min_replicas", "max_replicas",
    "autoscale_enabled", "autoscale_cpu_threshold", "autoscale_mem_threshold",
    "autoscale_req_threshold", "autoscale_cooldown", "scale_to_zero_after",
  ].some((f) => changed.has(f))) {
    db.updateAppScaling(app.id, {
      desired_replicas: desired.desired_replicas,
      min_replicas: desired.min_replicas,
      max_replicas: desired.max_replicas,
      autoscale_enabled: desired.autoscale_enabled,
      autoscale_cpu_threshold: desired.autoscale_cpu_threshold,
      autoscale_mem_threshold: desired.autoscale_mem_threshold,
      autoscale_req_threshold: desired.autoscale_req_threshold,
      autoscale_cooldown: desired.autoscale_cooldown,
      scale_to_zero_after: desired.scale_to_zero_after,
    });
  }
  if (
    ["webhook_enabled", "webhook_branch", "webhook_path", "webhook_wait_for_ci"].some((f) => changed.has(f)) ||
    changed.has("webhook_staging_environment_id") ||
    (
      effective.webhook_staging === true &&
      effective.webhook_staging_environment_id == null
    )
  ) {
    await applyWebhook(db.getApp(app.id)!, effective, opts.userId, opts.log);
  }
  if (effective.manifest_path && effective.manifest_hash) {
    db.recordAppManifestApplied(app.id, effective.manifest_path, effective.manifest_hash);
  }
  if (opts.userId) db.updateAppDeployedBy(app.id, opts.userId);
  return changes;
}
