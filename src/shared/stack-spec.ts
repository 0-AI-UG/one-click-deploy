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
 * `manifestDir` is the app manifest's repo-root-relative directory; the
 * Dockerfile path is resolved against it so monorepo apps build the right file
 * (matching introspectRepo's behavior for single-app deploys).
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
    git_repo: repo,
    container_port: manifest.build?.container_port ?? 3000,
    declared_env_keys: [...new Set((manifest.env ?? []).map((entry) => entry.key))],
  };
  if (manifest.environment !== undefined) spec.environment = manifest.environment;
  if (manifest.image) {
    spec.git_repo = "";
    spec.image_ref = manifest.image.ref;
  }
  if (manifest.build?.cache_ref) spec.build_cache_ref = manifest.build.cache_ref;

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
  const gitBranch = manifest.git_branch;
  if (gitBranch) spec.git_branch = gitBranch;
  if (manifest.build?.dockerfile) {
    spec.dockerfile_path = manifestDir
      ? `${manifestDir}/${manifest.build.dockerfile}`
      : manifest.build.dockerfile;
  }
  if (manifest.build?.context) spec.docker_context = manifest.build.context;

  if (manifest.webhook?.enabled) {
    spec.webhook_enabled = true;
    spec.webhook_branch = manifest.webhook.branch || "main";
    if (manifest.webhook.path) spec.webhook_path = manifest.webhook.path;
    if (manifest.webhook.wait_for_ci) spec.webhook_wait_for_ci = true;
    // Staging is opt-in per member, declared in the member's own manifest. The
    // ENVIRONMENT it deploys with is not known here — it comes from the stack's
    // shared staging env and is resolved in the deploy_stack op, exactly like
    // env_vars.
    if (manifest.webhook.staging) spec.webhook_staging = true;
    if (manifest.webhook.staging_environment !== undefined) {
      spec.webhook_staging_environment = manifest.webhook.staging_environment;
    }
  }

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
  if (healthCheck?.enabled === false) spec.health_check = false;
  if (healthCheck?.mode) spec.health_check_mode = healthCheck.mode;
  if (healthCheck?.mode) spec.health_check = healthCheck.mode === "http";
  if (healthCheck?.command) spec.health_check_command = healthCheck.command;
  if (healthCheck?.file) spec.health_check_file = healthCheck.file;
  if (healthCheck?.max_age_seconds) spec.health_check_max_age_seconds = healthCheck.max_age_seconds;
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
  spec.volume_size = manifest.volume?.size ?? 0;
  spec.volume_path = manifest.volume?.path ?? "/data";
  if (manifest.extra_volumes?.length) spec.extra_volumes = manifest.extra_volumes;

  return spec;
}
