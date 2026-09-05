// Single source of truth for turning a per-app DeployManifest (+ its stack-entry
// overrides) into the wire fields the deploy op expects. The CLI and optional
// repository-introspection API share it, so every manifest-driven stack uses
// the same mapping. Pure + dependency-light so it is safe in the CLI bundle.

import type { StackManifest, StackDeployRequest, DeployManifest } from "./rpc.ts";

export type StackAppSpec = StackDeployRequest["apps"][number];

/** Resolve a repo-root-relative path from a base dir + a manifest-relative ref,
 *  collapsing "." and ".." segments (no node:path so this stays portable). */
export function resolveRepoPath(baseDir: string, rel: string): string {
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/** Directory portion of a repo-root-relative path ("" when at the root). */
export function repoDirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Map an app's DeployManifest (+ stack-entry overrides) onto a StackAppSpec.
 * env_vars are NOT set here — the caller attaches the values collected from
 * manifest defaults, CLI flags, linked environments, and secure prompts.
 *
 * `repo` and `manifestDir` are retained in the helper signature until callers
 * are simplified; source location never enters the deployment spec.
 */
export function buildStackAppSpec(
  key: string,
  entry: StackManifest["apps"][string],
  manifest: DeployManifest,
  repo: string,
  manifestDir: string,
): StackAppSpec {
  // The referenced app manifest is the canonical, full-capability app spec.
  // Stack entries add dependency/env wiring and the two useful deployment
  // overrides (domain/public) rather than duplicating that entire schema.
  const healthCheck = manifest.health_check;
  const spec: StackAppSpec = {
    apply_mode: "manifest",
    key,
    app_name: key, // server derives <stack>-<key>; sent only to satisfy the type
    container_port: manifest.container_port ?? 3000,
    declared_env_keys: [...new Set((manifest.env ?? []).map((entry) => entry.key))],
  };
  if (manifest.build) spec.build = manifest.build;
  if (manifest.image) spec.image_ref = manifest.image;
  spec.delivery_source = manifest.build ? "build" : "image";
  if (manifest.storage) spec.storage = manifest.storage;
  if (manifest.exports) spec.exports = manifest.exports;
  if (manifest.environment !== undefined) spec.environment = manifest.environment;

  if (entry.needs) spec.needs = entry.needs;
  if (entry.env !== undefined) {
    spec.env_projection = entry.env;
    spec.env_projection_mode = "explicit";
  } else if (entry.env_all) {
    spec.env_projection = null;
    spec.env_projection_mode = "all";
  } else if (manifest.env_projection !== undefined) {
    spec.env_projection = manifest.env_projection;
    spec.env_projection_mode = "explicit";
  } else {
    // A new stack member receives only variables it declared plus dependency
    // injection keys resolved by deploy_stack. Existing stored members preserve
    // their current projection when this default intent is applied.
    spec.env_projection = spec.declared_env_keys;
    spec.env_projection_mode = "declared";
  }
  const domain = entry.domain ?? manifest.domain;
  if (domain) spec.domain = domain;

  const replicas = manifest.replicas;
  if (replicas) spec.replicas = replicas;
  if (manifest.autoscaling) {
    spec.autoscale_enabled = manifest.autoscaling.enabled ?? false;
    spec.min_replicas = manifest.autoscaling.min_replicas ?? 1;
    spec.max_replicas = manifest.autoscaling.max_replicas ?? 1;
    spec.autoscale_cpu_threshold = manifest.autoscaling.cpu_threshold ?? 80;
    spec.autoscale_mem_threshold = manifest.autoscaling.memory_threshold ?? 85;
    spec.autoscale_req_threshold = manifest.autoscaling.requests_per_minute ?? 0;
    spec.autoscale_cooldown = manifest.autoscaling.cooldown_seconds ?? 300;
  }
  const isPublic = entry.public ?? manifest.public;
  if (isPublic !== undefined) spec.public = isPublic;
  const memoryMb = manifest.memory_mb;
  if (memoryMb !== undefined) spec.memory_mb = memoryMb;
  const cpuLimit = manifest.cpu_limit;
  if (cpuLimit !== undefined) spec.cpu_limit = cpuLimit;
  if (manifest.command) spec.command = manifest.command;
  if (manifest.cap_add) spec.cap_add = manifest.cap_add;
  if (manifest.post_start?.command) spec.post_start_command = manifest.post_start.command;
  if (healthCheck?.enabled === false) spec.health_check = false;
  if (healthCheck?.mode) spec.health_check_mode = healthCheck.mode;
  if (healthCheck?.mode) spec.health_check = healthCheck.mode === "http";
  if (healthCheck?.command) spec.health_check_command = healthCheck.command;
  if (healthCheck?.file) spec.health_check_file = healthCheck.file;
  if (healthCheck?.max_age_seconds) spec.health_check_max_age_seconds = healthCheck.max_age_seconds;
  if (healthCheck?.expected_statuses) spec.health_check_expected_statuses = healthCheck.expected_statuses;
  const internalProtocol = manifest.internal_protocol;
  if (internalProtocol) spec.internal_protocol = internalProtocol;
  const sticky = manifest.sticky;
  if (sticky !== undefined) spec.sticky = sticky;
  const rateLimit = manifest.rate_limit_rps;
  if (rateLimit !== undefined) spec.rate_limit_rps = rateLimit;
  const allowlist = manifest.ip_allowlist;
  if (allowlist !== undefined) spec.ip_allowlist = allowlist;
  if (healthCheck?.enabled !== false && healthCheck?.path)
    spec.health_check_path = healthCheck.path;
  const compress = manifest.compress;
  if (compress !== undefined) spec.compress = compress;
  const publicPort = manifest.public_port;
  if (publicPort !== undefined) spec.public_port = publicPort;
  const publicProtocol = manifest.public_protocol;
  if (publicProtocol) spec.public_protocol = publicProtocol;
  const durability = manifest.durability_class;
  if (durability) spec.durability_class = durability;
  const placementPool = manifest.placement_pool;
  if (placementPool) spec.placement_pool = placementPool;
  const scaleToZeroAfter = manifest.scale_to_zero_after;
  if (scaleToZeroAfter !== undefined) spec.scale_to_zero_after = scaleToZeroAfter;

  spec.volume_id = manifest.volume?.id ?? "";
  spec.volume_driver = manifest.volume?.driver;
  spec.volume_size = manifest.volume?.size ?? 0;
  spec.volume_path = manifest.volume?.path ?? "/data";
  if (manifest.extra_volumes?.length) spec.extra_volumes = manifest.extra_volumes;

  return spec;
}
