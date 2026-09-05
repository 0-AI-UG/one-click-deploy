import { getAppStorage, resolveStorageBindings, saveAppStorage, prepareStorageBindings } from "./object-storage.ts";
import * as db from "./db.ts";
import type { AppRow } from "./db/apps.ts";
import type { DeployRequest } from "./rpc.ts";
import { parseRuntimeConfig, serializeRuntimeConfig, preflightRuntimeEnv, runtimeAppFromRequest } from "./runtime-env.ts";
import { resolveDurability } from "./durability.ts";
import { validateDeployRequest } from "./validate.ts";

export type AppConfigChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type AppReconcileMode = "control" | "runtime" | "artifact";

const ARTIFACT_CONFIG_FIELDS = new Set(["image_ref"]);

const RUNTIME_CONFIG_FIELDS = new Set([
  "storage", "container_port", "environment_id", "env", "outputs", "memory_mb", "cpu_limit",
  "health_check", "health_check_mode", "health_check_command", "health_check_file",
  "health_check_max_age_seconds", "health_check_expected_statuses", "internal_protocol",
  "extra_volumes", "desired_volume_id", "desired_volume_size", "desired_volume_path", "desired_volume_driver",
  "command", "cap_add", "post_start_command",
]);

/** Classify the least disruptive convergence action for a desired-config diff.
 * Artifact identity and runtime execution settings require container
 * recreation; placement and autoscaling policy are control-plane only. */
export function classifyAppConfigChanges(changes: AppConfigChange[]): AppReconcileMode {
  if (changes.some((change) => ARTIFACT_CONFIG_FIELDS.has(change.field))) return "artifact";
  if (changes.some((change) => RUNTIME_CONFIG_FIELDS.has(change.field))) return "runtime";
  return "control";
}

/** A config-only apply keeps runtime settings truthful by recreating
 * containers from the current immutable artifact. */
export function classifyConfigOnlyChanges(
  changes: AppConfigChange[],
  options: { environmentChanged?: boolean } = {},
): { rollout: "control" | "runtime"; pendingRollout: boolean } {
  const pendingRollout = changes.some((change) => ARTIFACT_CONFIG_FIELDS.has(change.field));
  const runtime = options.environmentChanged === true ||
    changes.some((change) => RUNTIME_CONFIG_FIELDS.has(change.field));
  return { rollout: runtime ? "runtime" : "control", pendingRollout };
}

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

/** Normalize a complete manifest application for an existing app.
 *
 * Runtime-assigned identity (the generated domain), stack ownership, and attached-volume state
 * are retained. Every manifest-owned scalar uses its documented default.
 */
export function mergeDeployRequestWithExistingApp(
  app: AppRow,
  manifest: Partial<DeployRequest> & { dry_run?: boolean; deploy?: boolean },
): DeployRequest {
  const supplied = resolveDeployRequestEnvironmentIds({
    ...manifest,
    app_name: manifest.app_name ?? app.name,
    container_port: manifest.container_port ?? app.container_port,
  });
  const publicApp = supplied.public !== undefined
    ? supplied.public
    : true;
  const merged: DeployRequest = {
    apply_mode: "manifest",
    app_name: supplied.app_name,
    domain: publicApp ? supplied.domain ?? app.domain : "",
    image_ref: supplied.image_ref ?? "",
    container_port: supplied.container_port,
    env: supplied.env ?? {},
    outputs: supplied.outputs ?? {},
    storage: resolveStorageBindings(supplied.storage, getAppStorage(app.id)),
    public: publicApp,
    memory_mb: supplied.memory_mb ?? 0,
    cpu_limit: supplied.cpu_limit ?? 0,
    auth_password: supplied.auth_password ?? "",
    health_check: supplied.health_check ?? true,
    health_check_mode: supplied.health_check_mode ??
      (supplied.health_check !== undefined
        ? supplied.health_check ? "http" : "container"
        : "http"),
    health_check_command: supplied.health_check_command ?? "",
    health_check_file: supplied.health_check_file ?? "",
    health_check_max_age_seconds: supplied.health_check_max_age_seconds ?? 0,
    health_check_expected_statuses: supplied.health_check_expected_statuses ?? [200],
    environment: supplied.environment,
    environment_id: supplied.environment_id ?? null,
    internal_protocol: supplied.internal_protocol ?? "http",
    sticky: supplied.sticky ?? false,
    rate_limit_rps: supplied.rate_limit_rps ?? 0,
    ip_allowlist: supplied.ip_allowlist ?? "",
    health_check_path: supplied.health_check_path ?? "",
    compress: supplied.compress ?? false,
    public_port: supplied.public_port !== undefined
      ? supplied.public_port
      : null,
    public_protocol: supplied.public_protocol ?? "tcp",
    placement_pool: supplied.placement_pool ?? "general",
    durability_class: supplied.durability_class ?? "none",
    replicas: supplied.replicas ?? 1,
    min_replicas: supplied.min_replicas ?? 1,
    max_replicas: supplied.max_replicas ?? 1,
    autoscale_enabled: supplied.autoscale_enabled ?? AUTOSCALE_DEFAULTS.enabled,
    autoscale_cpu_threshold: supplied.autoscale_cpu_threshold ?? AUTOSCALE_DEFAULTS.cpuThreshold,
    autoscale_mem_threshold: supplied.autoscale_mem_threshold ?? AUTOSCALE_DEFAULTS.memoryThreshold,
    autoscale_req_threshold: supplied.autoscale_req_threshold ?? AUTOSCALE_DEFAULTS.requestsPerMinute,
    autoscale_cooldown: supplied.autoscale_cooldown ?? AUTOSCALE_DEFAULTS.cooldownSeconds,
    scale_to_zero_after: supplied.scale_to_zero_after ?? 0,
    extra_volumes: supplied.extra_volumes ?? [],
    target: supplied.target ?? app.target,
    target_of: supplied.target_of ?? app.target_of ?? undefined,
    volume_id: supplied.volume_id ?? "",
    volume_driver: supplied.volume_driver ?? app.desired_volume_driver ?? undefined,
    volume_size: supplied.volume_size ?? 0,
    volume_path: supplied.volume_path ?? "/data",
    manifest_path: supplied.manifest_path,
    manifest_hash: supplied.manifest_hash,
    command: supplied.command ?? db.parseAppCommand(app),
    cap_add: supplied.cap_add ?? db.parseAppCapabilities(app),
    post_start_command: supplied.post_start_command ?? app.post_start_command,
  };
  return merged;
}

function normalizedSpec(req: DeployRequest) {
  const scaling = normalizeAppScaling(req);
  return {
    domain: req.domain ?? "",
    image_ref: req.image_ref ?? "",
    container_port: req.container_port,
    environment_id: req.environment_id,
    env: req.env ?? {},
    outputs: req.outputs ?? {},
    storage: req.storage ?? {},
    public: req.public ?? true,
    memory_mb: req.memory_mb ?? 0,
    cpu_limit: req.cpu_limit ?? 0,
    health_check: req.health_check_mode ? req.health_check_mode === "http" : (req.health_check ?? true),
    health_check_mode: req.health_check_mode ?? (req.health_check === false ? "container" : "http"),
    health_check_command: req.health_check_command ?? "",
    health_check_file: req.health_check_file ?? "",
    health_check_max_age_seconds: req.health_check_max_age_seconds ?? 0,
    health_check_expected_statuses: req.health_check_expected_statuses ?? [200],
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
    desired_volume_id: req.volume_id ?? "",
    desired_volume_size: req.volume_size ?? 0,
    desired_volume_path: req.volume_path ?? "/data",
    desired_volume_driver: req.volume_driver ?? "",
    command: req.command ?? [],
    cap_add: req.cap_add ?? [],
    post_start_command: req.post_start_command ?? "",
  };
}

function comparableApp(app: AppRow) {
  return {
    domain: app.domain || "",
    image_ref: app.image_ref || "",
    container_port: app.container_port,
    environment_id: app.environment_id,
    ...parseRuntimeConfig(app.env_vars),
    storage: getAppStorage(app.id),
    public: !!app.public,
    memory_mb: app.memory_mb ?? 0,
    cpu_limit: app.cpu_limit ?? 0,
    health_check: !!app.health_check,
    health_check_mode: app.health_check_mode || (app.health_check ? "http" : "container"),
    health_check_command: app.health_check_command || "",
    health_check_file: app.health_check_file || "",
    health_check_max_age_seconds: app.health_check_max_age_seconds || 0,
    health_check_expected_statuses: (() => {
      try {
        const parsed = JSON.parse(app.health_check_expected_statuses || "[200]");
        return Array.isArray(parsed) ? parsed : [200];
      } catch { return [200]; }
    })(),
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
    desired_volume_id: app.desired_volume_id || "",
    desired_volume_size: app.desired_volume_size ?? 0,
    desired_volume_path: app.desired_volume_path || "/data",
    desired_volume_driver: app.desired_volume_driver || "",
    command: db.parseAppCommand(app),
    cap_add: db.parseAppCapabilities(app),
    post_start_command: app.post_start_command || "",
  };
}

/** Reconstruct the complete desired app spec from persisted state. Release
 * endpoints use this as an atomic candidate and replace only `image_ref`, so
 * publishing a new artifact can never reset unrelated configuration. */
export function deployRequestFromApp(app: AppRow): DeployRequest {
  const current = comparableApp(app);
  return {
    apply_mode: "manifest",
    app_name: app.name,
    domain: current.domain,
    image_ref: app.image_ref,
    container_port: app.container_port,
    environment_id: app.environment_id,
    ...parseRuntimeConfig(app.env_vars),
    storage: getAppStorage(app.id),
    public: current.public,
    memory_mb: current.memory_mb,
    cpu_limit: current.cpu_limit,
    health_check: current.health_check,
    health_check_mode: current.health_check_mode as DeployRequest["health_check_mode"],
    health_check_command: current.health_check_command,
    health_check_file: current.health_check_file,
    health_check_max_age_seconds: current.health_check_max_age_seconds,
    health_check_expected_statuses: current.health_check_expected_statuses,
    internal_protocol: current.internal_protocol as DeployRequest["internal_protocol"],
    sticky: current.sticky,
    rate_limit_rps: current.rate_limit_rps,
    ip_allowlist: current.ip_allowlist,
    health_check_path: current.health_check_path,
    compress: current.compress,
    public_port: current.public_port,
    public_protocol: current.public_protocol as DeployRequest["public_protocol"],
    replicas: app.desired_replicas,
    min_replicas: app.min_replicas,
    max_replicas: app.max_replicas,
    autoscale_enabled: !!app.autoscale_enabled,
    autoscale_cpu_threshold: app.autoscale_cpu_threshold,
    autoscale_mem_threshold: app.autoscale_mem_threshold,
    autoscale_req_threshold: app.autoscale_req_threshold,
    autoscale_cooldown: app.autoscale_cooldown,
    durability_class: app.durability_class as DeployRequest["durability_class"],
    placement_pool: app.placement_pool,
    scale_to_zero_after: app.scale_to_zero_after,
    extra_volumes: db.parseExtraVolumes(app.extra_volumes).map((entry) => {
      const separator = entry.indexOf(":");
      return { host_path: entry.slice(0, separator), container_path: entry.slice(separator + 1) };
    }),
    volume_id: app.desired_volume_id,
    volume_size: app.desired_volume_size,
    volume_path: app.desired_volume_path,
    volume_driver: app.desired_volume_driver || undefined,
    command: current.command,
    cap_add: current.cap_add,
    post_start_command: current.post_start_command,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
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
      const redact = (input: unknown) => field === "env"
        ? Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).map(([key, entry]) => [key, typeof entry === "string" ? "••••••••" : entry]))
        : field === "outputs"
          ? Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).map(([key]) => [key, "••••••••"]))
          : input;
      changes.push({ field, before: redact(before[field]), after: redact(value) });
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
  const config = serializeRuntimeConfig(req);
  if (!sameValue(parseRuntimeConfig(config), parseRuntimeConfig(app.env_vars))) db.updateAppEnvVars(app.id, config);
}

/** Apply a complete normalized desired spec to an existing app. It never
 * deploys code and never deletes an environment; callers decide whether to
 * enqueue a rollout after the configuration transaction succeeds. */
export async function applyAppConfig(
  appId: number,
  req: DeployRequest,
  opts: {
    userId?: string;
    log?: (line: string) => void;
    allowUnchangedLegacyVolumeIntent?: boolean;
  } = {},
): Promise<AppConfigChange[]> {
  const app = db.getApp(appId);
  if (!app) throw new Error("App not found");
  const effective = mergeDeployRequestWithExistingApp(app, req);
  const preservesLegacyVolumeIntent = opts.allowUnchangedLegacyVolumeIntent === true &&
    app.desired_volume_size < 0 &&
    effective.volume_size === app.desired_volume_size &&
    effective.volume_id === app.desired_volume_id &&
    effective.volume_path === app.desired_volume_path;
  const effectiveValidation = validateDeployRequest(preservesLegacyVolumeIntent
    ? { ...effective, volume_id: "", volume_size: 0 }
    : effective);
  if (!effectiveValidation.valid) throw new Error(effectiveValidation.error);
  if (effective.app_name !== app.name) throw new Error(`Manifest targets "${effective.app_name}", but app #${appId} is "${app.name}"`);
  const desired = normalizedSpec(effective);
  const changes = diffAppConfig(app, effective);
  const changed = new Set(changes.map((c) => c.field));
  await preflightRuntimeEnv(runtimeAppFromRequest(effective, app.stack_id));
  await prepareStorageBindings(app, desired.storage);
  await applyEnvironment(app, effective);
  if (changed.has("storage")) saveAppStorage(app.id, desired.storage);
  if ([
    "image_ref", "health_check_mode", "health_check_command",
    "health_check_file", "health_check_max_age_seconds", "health_check_expected_statuses",
  ].some((f) => changed.has(f))) {
    db.updateAppArtifactAndHealth(app.id, {
      imageRef: desired.image_ref,
      healthMode: desired.health_check_mode,
      healthCommand: desired.health_check_command,
      healthFile: desired.health_check_file,
      healthMaxAgeSeconds: desired.health_check_max_age_seconds,
      healthExpectedStatuses: desired.health_check_expected_statuses,
    });
  }
  if (changed.has("container_port")) db.updateAppContainerPort(app.id, desired.container_port);
  if (changed.has("domain") && req.domain !== undefined) db.updateAppDomain(app.id, req.domain);
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
  if (effective.auth_password !== undefined && (effective.auth_password !== "" || app.auth_password_hash !== "")) {
    db.updateAppAuthPassword(app.id, effective.auth_password);
  }
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
  if (["command", "cap_add", "post_start_command"].some((f) => changed.has(f))) {
    db.updateAppRuntimeOptions(app.id, {
      command: desired.command,
      capAdd: desired.cap_add,
      postStartCommand: desired.post_start_command,
    });
  }
  if (["desired_volume_id", "desired_volume_size", "desired_volume_path", "desired_volume_driver"].some((f) => changed.has(f))) {
    db.updateAppDesiredVolume(app.id, {
      volumeId: desired.desired_volume_id,
      sizeGb: desired.desired_volume_size,
      mountPath: desired.desired_volume_path,
      driverId: desired.desired_volume_driver,
    });
  }
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
  if (opts.userId) db.updateAppDeployedBy(app.id, opts.userId);
  db.normalizeAppConfigRevision(app.id, app.config_revision);
  if (effective.manifest_path && effective.manifest_hash) {
    db.recordAppManifestApplied(app.id, effective.manifest_path, effective.manifest_hash);
  }
  return changes;
}
