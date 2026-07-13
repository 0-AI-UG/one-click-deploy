// Single source of truth for turning a per-app DeployManifest (+ its stack-entry
// overrides) into the wire fields the deploy op expects. Both the CLI
// (`ocd stack up`, cli/commands/stack.ts) and the web builder (server-side
// introspectStack) call this, so a stack deploys identically from either front
// end. Pure + dependency-light so it's safe to import from the CLI bundle.

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
 * env_vars are NOT set here — each front end attaches them (the CLI collects
 * them from the manifest/flags/prompts, the web from the builder form).
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
  const spec: StackAppSpec = {
    key,
    app_name: key, // server derives <stack>-<key>; sent only to satisfy the type
    git_repo: repo,
    container_port: manifest.build?.container_port ?? 3000,
  };

  if (entry.needs) spec.needs = entry.needs;
  if (entry.domain) spec.domain = entry.domain;
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
  }

  if (manifest.replicas) spec.replicas = manifest.replicas;
  if (entry.public !== undefined) spec.public = entry.public;
  else if (manifest.public !== undefined) spec.public = manifest.public;
  if (manifest.memory_mb) spec.memory_mb = manifest.memory_mb;
  if (manifest.cpu_limit) spec.cpu_limit = manifest.cpu_limit;
  if (manifest.health_check?.enabled === false) spec.health_check = false;
  if (manifest.internal_protocol) spec.internal_protocol = manifest.internal_protocol;
  if (manifest.sticky) spec.sticky = true;
  if (manifest.rate_limit_rps !== undefined) spec.rate_limit_rps = manifest.rate_limit_rps;
  if (manifest.ip_allowlist) spec.ip_allowlist = manifest.ip_allowlist;
  if (manifest.health_check?.enabled !== false && manifest.health_check?.path)
    spec.health_check_path = manifest.health_check.path;
  if (manifest.compress) spec.compress = true;
  if (manifest.public_port !== undefined && manifest.public_port !== null)
    spec.public_port = manifest.public_port;
  if (manifest.public_protocol) spec.public_protocol = manifest.public_protocol;

  if (manifest.volume?.size) {
    spec.volume_size = manifest.volume.size;
    spec.volume_path = manifest.volume.path || "/data";
  }
  if (manifest.extra_volumes?.length) spec.extra_volumes = manifest.extra_volumes;

  return spec;
}
