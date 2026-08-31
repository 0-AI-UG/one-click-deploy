import { publicPortRange, type PublicProtocol, type InternalProtocol } from "./db/apps.ts";
import {
  DeployManifestSchema,
  got as gotManifestValue,
  MIN_MEMORY_MB,
  MAX_MEMORY_MB,
  MIN_CPU_LIMIT,
  MAX_CPU_LIMIT,
  isValidMemoryMb,
  isValidCpuLimit,
  isValidRateLimitRps,
} from "./manifest-schema.ts";
import type { DeployManifest } from "./rpc.ts";
import { resolveDurability } from "./durability.ts";

// The manifest shape/bounds now live once in ./manifest-schema.ts (the Zod
// source of truth). Re-export the numeric bounds/predicates here so existing
// importers of them from ./validate.ts (e.g. server/routes/apps.ts) keep
// working unchanged.
export {
  MIN_MEMORY_MB,
  MAX_MEMORY_MB,
  MIN_CPU_LIMIT,
  MAX_CPU_LIMIT,
  isValidMemoryMb,
  isValidCpuLimit,
  isValidRateLimitRps,
};

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

export function validateAppName(name: string): ValidationResult<string> {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return { valid: false, error: "App name is required" };
  if (trimmed.length > 63)
    return { valid: false, error: "App name must be 63 characters or fewer" };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(trimmed) && trimmed.length > 1)
    return {
      valid: false,
      error:
        "App name must start and end with a letter or digit, and contain only lowercase letters, digits, or hyphens",
    };
  if (trimmed.length === 1 && !/^[a-z0-9]$/.test(trimmed))
    return {
      valid: false,
      error: "App name must be a lowercase letter or digit",
    };
  if (/--/.test(trimmed))
    return { valid: false, error: "App name must not contain consecutive hyphens" };
  return { valid: true, value: trimmed };
}

export function validateDomain(domain: string): ValidationResult<string> {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return { valid: false, error: "Domain is required" };
  if (trimmed.length > 253)
    return { valid: false, error: "Domain must be 253 characters or fewer" };

  const labels = trimmed.split(".");
  if (labels.length < 2)
    return { valid: false, error: "Domain must have at least two labels (e.g., example.com)" };

  for (const label of labels) {
    if (!label)
      return { valid: false, error: "Domain contains empty labels" };
    if (label.length > 63)
      return { valid: false, error: `Domain label "${label}" exceeds 63 characters` };
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
      return {
        valid: false,
        error: `Domain label "${label}" must start and end with a letter or digit, and contain only letters, digits, or hyphens`,
      };
  }

  return { valid: true, value: trimmed };
}

export function validatePort(port: number): ValidationResult<number> {
  if (!Number.isInteger(port))
    return { valid: false, error: "Port must be an integer" };
  if (port < 1 || port > 65535)
    return { valid: false, error: "Port must be between 1 and 65535" };
  return { valid: true, value: port };
}

const RESERVED_ENV_PREFIXES = ["DOCKER_", "PATH", "HOME", "LD_", "DYLD_"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnvVars(
  vars: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>
): ValidationResult<Record<string, string>> {
  const entries = Array.isArray(vars)
    ? vars.map((v) => [v.key, v.value] as const)
    : Object.entries(vars);
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key))
      return {
        valid: false,
        error: `Environment variable key "${key}" is invalid. Keys must start with a letter or underscore and contain only letters, digits, or underscores.`,
      };
    if (RESERVED_ENV_PREFIXES.some((p) => key === p || key.startsWith(p + (p.endsWith("_") ? "" : "="))))
      // Only block exact matches for PATH/HOME, prefix matches for DOCKER_/LD_/DYLD_
      if (key === "PATH" || key === "HOME" || key.startsWith("DOCKER_") || key.startsWith("LD_") || key.startsWith("DYLD_"))
        return {
          valid: false,
          error: `Environment variable "${key}" uses a reserved prefix and cannot be set`,
        };
    if (value.includes("\0"))
      return {
        valid: false,
        error: `Environment variable "${key}" contains a null byte`,
      };
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return { valid: true, value: result };
}

function isIpv4(addr: string): boolean {
  const octets = addr.split(".");
  if (octets.length !== 4) return false;
  return octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

function isIpv6(addr: string): boolean {
  if (addr.includes(":::")) return false;
  const halves = addr.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  // Without "::" exactly 8 groups; with "::" at most 7 (it stands in for >= 1).
  if (halves.length === 1 && groups.length !== 8) return false;
  if (halves.length === 2 && groups.length > 7) return false;
  return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

/**
 * Validate a comma-separated list of IPv4/IPv6 addresses or CIDR blocks for
 * the per-app ingress IP allowlist (Traefik ipAllowList.sourceRange).
 * Returns the normalized list (trimmed entries, comma-joined); "" = allowlist
 * off. Rejected garbage never reaches the rendered Traefik config.
 */
export function validateIpAllowlist(raw: string): ValidationResult<string> {
  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    const [addr, prefix, ...rest] = entry.split("/");
    if (rest.length > 0)
      return { valid: false, error: `IP allowlist entry "${entry}" is not a valid IP or CIDR` };
    const v4 = isIpv4(addr);
    const v6 = !v4 && isIpv6(addr);
    if (!v4 && !v6)
      return { valid: false, error: `IP allowlist entry "${entry}" is not a valid IPv4/IPv6 address or CIDR` };
    if (prefix !== undefined) {
      const maxPrefix = v4 ? 32 : 128;
      if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > maxPrefix)
        return { valid: false, error: `IP allowlist entry "${entry}" has an invalid prefix length (0-${maxPrefix})` };
    }
  }
  return { valid: true, value: entries.join(",") };
}

/** Active HTTP health-check path (Traefik loadBalancer.healthCheck.path).
 *  "" = disabled. Must be an absolute path with no whitespace/control chars. */
export function validateHealthCheckPath(path: string): ValidationResult<string> {
  const trimmed = path.trim();
  if (!trimmed) return { valid: true, value: "" };
  if (!trimmed.startsWith("/"))
    return { valid: false, error: 'Health check path must start with "/"' };
  if (trimmed.length > 200)
    return { valid: false, error: "Health check path must be 200 characters or fewer" };
  if (!/^[!-~]+$/.test(trimmed))
    return { valid: false, error: "Health check path must not contain spaces or control characters" };
  return { valid: true, value: trimmed };
}

/**
 * Public raw TCP/UDP exposure port: must sit in the protocol's pool block
 * (see PUBLIC_TCP_PORT_BASE / PUBLIC_UDP_PORT_BASE). Freeness is checked
 * against the DB by callers — this only validates shape and range.
 */
export function validatePublicPort(port: unknown, protocol: PublicProtocol): ValidationResult<number> {
  if (typeof port !== "number" || !Number.isInteger(port))
    return { valid: false, error: "Public port must be an integer" };
  const { base, count } = publicPortRange(protocol);
  if (port < base || port >= base + count)
    return { valid: false, error: `Public ${protocol.toUpperCase()} ports are ${base}-${base + count - 1}` };
  return { valid: true, value: port };
}

export function isPublicProtocol(value: unknown): value is PublicProtocol {
  return value === "tcp" || value === "udp";
}

export function isInternalProtocol(value: unknown): value is InternalProtocol {
  return value === "http" || value === "tcp";
}

/**
 * Resolve a deploy request's internal routing protocol. `internal_protocol` is
 * an explicit, first-class field: a valid explicit value wins, otherwise it
 * defaults to "http". It is intentionally independent of `health_check` —
 * routing (L7 HTTP vs raw TCP pass-through) and the post-deploy probe (HTTP vs
 * container-running) are orthogonal, so a raw-TCP app (e.g. a database) must
 * set `internal_protocol: "tcp"` explicitly rather than relying on
 * `health_check`.
 */
export function resolveInternalProtocol(
  internalProtocol: unknown,
): InternalProtocol {
  return isInternalProtocol(internalProtocol) ? internalProtocol : "http";
}

/** Per-app ingress fields shared by deploy and the ingress-update endpoint.
 *  Every field is optional so a partial ingress PATCH validates only what it
 *  sends; deploy passes the full set. */
export type IngressFieldsInput = {
  /** Write-only plaintext; presence (truthy) means "enable basic auth". */
  auth_password?: string;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  public_port?: number | "auto" | null;
  public_protocol?: string;
};

/** Normalized ingress values (trimmed/joined) ready to persist. Only the keys
 *  that were present in the input are set. */
export type NormalizedIngressFields = {
  auth_password?: string;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  public_port?: number | "auto" | null;
  public_protocol?: PublicProtocol;
};

/**
 * Single source of truth for the ingress-field rules shared by
 * manifest and partial app-config apply paths. Returns the
 * normalized values (or the first error) so both call sites agree on both the
 * rules and the error strings. `httpRouted` is whether the app is (or will be)
 * HTTP-routed (internal_protocol='http') — password protection and an active
 * health-check path are Traefik HTTP-router features and can't gate a
 * raw-TCP-routed app.
 */
export function validateIngressFields(
  fields: IngressFieldsInput,
  ctx: { httpRouted: boolean },
): ValidationResult<NormalizedIngressFields> {
  const out: NormalizedIngressFields = {};

  // Password protection is a Traefik basicAuth middleware, which only exists
  // for HTTP routers — a raw-TCP-routed app can't enforce it.
  if (fields.auth_password !== undefined) {
    if (fields.auth_password && !ctx.httpRouted) {
      return { valid: false, error: "Password protection requires HTTP internal routing — it is enforced by HTTP basic auth at the ingress and cannot gate raw-TCP apps (set internal_protocol to 'http')" };
    }
    out.auth_password = fields.auth_password;
  }

  if (fields.rate_limit_rps !== undefined) {
    if (!isValidRateLimitRps(fields.rate_limit_rps)) {
      return { valid: false, error: "Rate limit must be an integer 0 (unlimited) to 1000000 requests/sec" };
    }
    out.rate_limit_rps = fields.rate_limit_rps;
  }

  if (fields.ip_allowlist !== undefined) {
    const allowResult = validateIpAllowlist(String(fields.ip_allowlist));
    if (!allowResult.valid) return { valid: false, error: allowResult.error };
    out.ip_allowlist = allowResult.value;
  }

  if (fields.health_check_path !== undefined) {
    const pathResult = validateHealthCheckPath(String(fields.health_check_path));
    if (!pathResult.valid) return { valid: false, error: pathResult.error };
    // The active HTTP health check lives on the app's HTTP loadBalancer;
    // raw-TCP-routed apps use a TCP connect check instead.
    if (pathResult.value && !ctx.httpRouted) {
      return { valid: false, error: "Health check path requires HTTP internal routing — raw-TCP apps use a TCP connect check instead (set internal_protocol to 'http')" };
    }
    out.health_check_path = pathResult.value;
  }

  // Raw TCP/UDP exposure is independent of HTTP publicness — an HTTP-private
  // app may still be TCP-exposed (e.g. a database).
  const protocol: PublicProtocol = isPublicProtocol(fields.public_protocol) ? fields.public_protocol : "tcp";
  if (fields.public_protocol !== undefined) {
    if (!isPublicProtocol(fields.public_protocol)) {
      return { valid: false, error: 'Public protocol must be "tcp" or "udp"' };
    }
    out.public_protocol = protocol;
  }
  if (fields.public_port !== undefined) {
    if (fields.public_port != null && fields.public_port !== "auto") {
      const portRes = validatePublicPort(fields.public_port, protocol);
      if (!portRes.valid) return { valid: false, error: portRes.error };
    }
    out.public_port = fields.public_port;
  }

  return { valid: true, value: out };
}


export function validateHetznerToken(token: string): ValidationResult<string> {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, error: "Token is required" };
  if (trimmed.length < 32)
    return { valid: false, error: "Token is too short (minimum 32 characters)" };
  if (trimmed.length > 128)
    return { valid: false, error: "Token is too long (maximum 128 characters)" };
  if (!/^[\x20-\x7e]+$/.test(trimmed))
    return { valid: false, error: "Token contains invalid characters" };
  return { valid: true, value: trimmed };
}

export function validateGitHubPat(token: string): ValidationResult<string> {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, error: "Token is required" };
  if (trimmed.length < 30)
    return { valid: false, error: "Token is too short" };
  if (trimmed.length > 256)
    return { valid: false, error: "Token is too long" };
  if (!/^[\x20-\x7e]+$/.test(trimmed))
    return { valid: false, error: "Token contains invalid characters" };
  return { valid: true, value: trimmed };
}

/**
 * Reject host paths that aren't in the per-app/service or block-storage
 * allowlist. Stops a control-plane user from mounting `/etc`, `/root`, or
 * another app's data dir into their container. Called both at the RPC
 * boundary (early reject) and inside buildDockerRunArgs (defense in depth).
 */
export function assertSafeHostPath(hostPath: string, appName: string): void {
  if (typeof hostPath !== "string" || hostPath.length === 0)
    throw new Error("Volume host path is required");
  if (!hostPath.startsWith("/"))
    throw new Error(`Volume host path must be absolute: ${hostPath}`);
  if (hostPath.includes(".."))
    throw new Error(`Volume host path must not contain '..': ${hostPath}`);
  if (hostPath.includes("\0") || /\s/.test(hostPath))
    throw new Error(`Volume host path contains invalid characters: ${hostPath}`);
  // Collapse duplicate slashes for the prefix check, but reject anything that
  // would resolve outside the allowed roots.
  const normalized = hostPath.replace(/\/+/g, "/");

  // App name must be safe — we interpolate it into the allowed prefix.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appName))
    throw new Error(`Invalid app name for volume scoping: ${appName}`);

  const allowedPrefixes = [
    `/home/deploy/apps/${appName}/`,
    `/home/deploy/services/${appName}/`,
    `/mnt/ocd-`, // block-storage mounts created by the volume provisioner
    `/mnt/vol-`, // pre-existing block volumes attached by id (attach-existing)
  ];
  if (!allowedPrefixes.some((p) => normalized.startsWith(p)))
    throw new Error(
      `Volume host path "${hostPath}" is not in the allowlist. ` +
      `Allowed prefixes: ${allowedPrefixes.join(", ")}`,
    );
}

/**
 * Server-side (web-deploy) manifest validator: a result-style adapter over the
 * canonical `DeployManifestSchema`. The schema is the single source of truth
 * for the manifest SHAPE and numeric BOUNDS — this function no longer restates
 * them. It then layers the web-path-only semantic checks the schema doesn't
 * encode: the shared ingress rules (IP-allowlist format, health-check-path shape, public-port pool range,
 * and the HTTP-routing cross-field constraints). Unknown keys are tolerated
 * (forward-compat), matching the old behavior.
 */
export function validateDeployManifest(
  raw: unknown,
): { ok: true; manifest: DeployManifest } | { ok: false; error: string } {
  const parsed = DeployManifestSchema.safeParse(raw);
  if (!parsed.success) {
    // Unknown keys are non-fatal here (forward-compat); surface the first real
    // shape/bounds issue as a single human-readable string.
    const hard = parsed.error.issues.filter((i) => i.code !== "unrecognized_keys");
    const first = hard[0];
    if (first) {
      const field = first.path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".");
      const gotValue = fieldValueAt(raw, first.path);
      const suffix = first.code === "custom" ? "" : `, got ${gotManifestValue(gotValue)}`;
      return { ok: false, error: field ? `${field}: ${first.message}${suffix}` : `${first.message}${suffix}` };
    }
    // else: only unknown keys — fall through and treat as shape-valid.
  }

  const obj = raw as Record<string, unknown>;

  // Rate limit / allowlist / health-check path / public port+protocol share the
  // deploy request's rules — one validator, one set of error strings. The
  // health-check-path HTTP-routing rule keys off the manifest's resolved
  // internal protocol (explicit internal_protocol, else the "http" default).
  const healthCheck = obj.health_check;
  const healthPath =
    healthCheck && typeof healthCheck === "object" && !Array.isArray(healthCheck)
      ? ((healthCheck as Record<string, unknown>).path as string | undefined)
      : undefined;
  const httpRouted = resolveInternalProtocol(obj.internal_protocol) === "http";
  const ingressInput: IngressFieldsInput = {};
  if ("rate_limit_rps" in obj) ingressInput.rate_limit_rps = obj.rate_limit_rps as number;
  if ("ip_allowlist" in obj) ingressInput.ip_allowlist = obj.ip_allowlist as string;
  if (healthPath !== undefined) ingressInput.health_check_path = healthPath;
  if ("public_port" in obj) ingressInput.public_port = obj.public_port as number | "auto" | null;
  if ("public_protocol" in obj) ingressInput.public_protocol = obj.public_protocol as string;
  const ingressResult = validateIngressFields(ingressInput, { httpRouted });
  if (!ingressResult.valid) return { ok: false, error: ingressResult.error };

  return { ok: true, manifest: raw as DeployManifest };
}

/** Walk an object along a Zod issue path to recover the received value. */
function fieldValueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}


export function validateDeployRequest(req: {
  apply_mode?: "manifest";
  app_name: string;
  domain?: string;
  image_ref?: string;
  git_commit?: string;
  container_port: number;
  env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
  environment?: string | null;
  environment_id?: number | null;
  volume_id?: string;
  volume_size?: number;
  replicas?: number;
  durability_class?: string;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_enabled?: boolean;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_req_threshold?: number;
  autoscale_cooldown?: number;
  scale_to_zero_after?: number;
  memory_mb?: number;
  cpu_limit?: number;
  public?: boolean;
  auth_password?: string;
  health_check?: boolean;
  health_check_mode?: string;
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  health_check_expected_statuses?: number[];
  internal_protocol?: string;
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean;
  public_port?: number | "auto" | null;
  public_protocol?: string;
  command?: string[];
  cap_add?: string[];
  post_start_command?: string;
}): ValidationResult<void> {
  const nameResult = validateAppName(req.app_name);
  if (!nameResult.valid) return { valid: false, error: `App name: ${nameResult.error}` };

  if (!req.image_ref || !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(req.image_ref)) {
    return { valid: false, error: "Image must be an immutable OCI reference ending in @sha256:<64 hex digest>" };
  }
  if (req.git_commit && !/^[0-9a-f]{7,64}$/i.test(req.git_commit)) {
    return { valid: false, error: "Git commit SHA must contain 7-64 hexadecimal characters" };
  }
  if (req.command !== undefined && (
    !Array.isArray(req.command) ||
    req.command.some((part) => typeof part !== "string" || part.length === 0 || /[\0\r\n]/.test(part))
  )) {
    return { valid: false, error: "Command must be an array of non-empty strings without control characters" };
  }
  if (req.cap_add !== undefined && (
    !Array.isArray(req.cap_add) ||
    req.cap_add.some((cap) => typeof cap !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(cap))
  )) {
    return { valid: false, error: "Linux capabilities must use names such as CHOWN or SETUID" };
  }
  if (req.post_start_command !== undefined && /[\0]/.test(req.post_start_command)) {
    return { valid: false, error: "Post-start command must not contain NUL bytes" };
  }

  if (req.domain) {
    if (req.public === false) {
      return { valid: false, error: "Private apps cannot have a public domain" };
    }
    const domainResult = validateDomain(req.domain);
    if (!domainResult.valid) return { valid: false, error: `Domain: ${domainResult.error}` };
  }

  const portResult = validatePort(req.container_port);
  if (!portResult.valid) return { valid: false, error: `Port: ${portResult.error}` };
  if (
    req.health_check_expected_statuses !== undefined &&
    (
      !Array.isArray(req.health_check_expected_statuses) ||
      req.health_check_expected_statuses.length === 0 ||
      req.health_check_expected_statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
    )
  ) {
    return { valid: false, error: "Health check expected statuses must be a non-empty array of HTTP codes 100-599" };
  }

  if (req.env_vars) {
    const envResult = validateEnvVars(req.env_vars);
    if (!envResult.valid) return { valid: false, error: envResult.error };
  }

  if (
    req.replicas !== undefined &&
    (!Number.isInteger(req.replicas) || req.replicas < 1)
  ) {
    return {
      valid: false,
      error: "Replicas must be an integer >= 1",
    };
  }
  if (req.min_replicas !== undefined && (!Number.isInteger(req.min_replicas) || req.min_replicas < 0)) {
    return { valid: false, error: "Minimum replicas must be an integer >= 0" };
  }
  if (req.max_replicas !== undefined && (!Number.isInteger(req.max_replicas) || req.max_replicas < 1)) {
    return { valid: false, error: "Maximum replicas must be an integer >= 1" };
  }
  const durability = resolveDurability(req.durability_class, req.replicas);
  const durabilityFloor = durability.durabilityClass === "none"
    ? 0
    : durability.minReplicas;
  const minimum = Math.max(req.min_replicas ?? 1, durabilityFloor);
  const desired = Math.max(req.replicas ?? 1, durabilityFloor, minimum);
  const maximum = Math.max(req.max_replicas ?? 1, minimum, desired);
  if (
    req.max_replicas !== undefined &&
    req.min_replicas !== undefined &&
    req.max_replicas < req.min_replicas
  ) {
    return { valid: false, error: "Maximum replicas must be >= minimum replicas" };
  }
  for (const [label, value] of [
    ["CPU autoscale threshold", req.autoscale_cpu_threshold],
    ["Memory autoscale threshold", req.autoscale_mem_threshold],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 100)) {
      return { valid: false, error: `${label} must be an integer between 1 and 100` };
    }
  }
  if (
    req.autoscale_req_threshold !== undefined &&
    (!Number.isInteger(req.autoscale_req_threshold) || req.autoscale_req_threshold < 0)
  ) {
    return { valid: false, error: "Request autoscale threshold must be an integer >= 0" };
  }
  if (
    req.autoscale_cooldown !== undefined &&
    (!Number.isInteger(req.autoscale_cooldown) || req.autoscale_cooldown < 30)
  ) {
    return { valid: false, error: "Autoscale cooldown must be an integer >= 30 seconds" };
  }
  if (
    req.scale_to_zero_after !== undefined &&
    (!Number.isInteger(req.scale_to_zero_after) || req.scale_to_zero_after < 0)
  ) {
    return { valid: false, error: "Scale-to-zero delay must be an integer >= 0" };
  }
  if (req.volume_size && (desired > 1 || maximum > 1)) {
    return { valid: false, error: "Apps with persistent storage cannot have more than 1 replica" };
  }
  if (req.volume_size !== undefined && (!Number.isInteger(req.volume_size) || req.volume_size < 0)) {
    return { valid: false, error: "Volume size must be 0 or a positive integer" };
  }
  if (req.volume_id && !req.volume_size) {
    return { valid: false, error: "An explicit provider volume requires a positive desired size" };
  }

  if (req.memory_mb !== undefined && !isValidMemoryMb(req.memory_mb)) {
    return { valid: false, error: `Memory: must be an integer 0 (default) or ${MIN_MEMORY_MB}–${MAX_MEMORY_MB} MB` };
  }

  if (req.cpu_limit !== undefined && !isValidCpuLimit(req.cpu_limit)) {
    return { valid: false, error: `CPU: must be 0 (default) or a number ${MIN_CPU_LIMIT}–${MAX_CPU_LIMIT} cores` };
  }

  if (req.internal_protocol !== undefined && !isInternalProtocol(req.internal_protocol)) {
    return { valid: false, error: 'Internal protocol must be "http" or "tcp"' };
  }

  // Internal routing protocol: explicit value wins, else the "http" default
  // (independent of health_check). Auth / health-check-path rules key off the
  // resolved routing protocol (they are HTTP-router features).
  const internalProtocol = resolveInternalProtocol(req.internal_protocol);

  const healthMode = req.health_check_mode ?? (req.health_check === false ? "container" : "http");
  if (!["http", "container", "exec", "heartbeat", "periodic_job"].includes(healthMode)) {
    return { valid: false, error: "Health check mode is invalid" };
  }
  if (healthMode === "exec" && !req.health_check_command?.trim()) {
    return { valid: false, error: "Exec health checks require health_check.command" };
  }
  if (healthMode === "heartbeat" || healthMode === "periodic_job") {
    if (!req.health_check_file || !/^\/[A-Za-z0-9._/-]+$/.test(req.health_check_file)) {
      return { valid: false, error: `${healthMode} health checks require a safe absolute file path` };
    }
    if (!Number.isInteger(req.health_check_max_age_seconds) || (req.health_check_max_age_seconds ?? 0) < 1) {
      return { valid: false, error: `${healthMode} health checks require max_age_seconds >= 1` };
    }
  }
  if (healthMode !== "http" && req.health_check_path) {
    return { valid: false, error: "health_check.path is only valid for HTTP health checks" };
  }

  // Auth / rate limit / allowlist / health-check path / public-port rules are
  // shared with the ingress-update endpoint — one validator, one set of errors.
  const ingressResult = validateIngressFields(
    {
      auth_password: req.auth_password,
      rate_limit_rps: req.rate_limit_rps,
      ip_allowlist: req.ip_allowlist,
      health_check_path: req.health_check_path,
      public_port: req.public_port,
      public_protocol: req.public_protocol,
    },
    { httpRouted: internalProtocol === "http" },
  );
  if (!ingressResult.valid) return { valid: false, error: ingressResult.error };

  return { valid: true, value: undefined };
}

const BUILD_REPOSITORY = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+(?:\.git)?$/;
const BUILD_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i;

/** Validate a request before its source is built. Runtime deploy operations
 * still receive and validate only the resulting immutable image_ref. */
export function validateBuildDeployRequest(req: Parameters<typeof validateDeployRequest>[0] & {
  build?: {
    repository: string;
    branch?: string;
    dockerfile: string;
    context: string;
    image_repository: string;
    platform?: "linux/amd64";
    cache?: boolean;
    webhook?: boolean;
  };
}): ValidationResult<void> {
  const build = req.build;
  if (!build) return { valid: false, error: "Build configuration is required" };
  if (!BUILD_REPOSITORY.test(build.repository)) {
    return { valid: false, error: "Build repository must be an HTTPS Git URL" };
  }
  if (!(build.branch || "main").trim() || /[\s~^:?*\\\[]/.test(build.branch || "main")) {
    return { valid: false, error: "Build branch is invalid" };
  }
  for (const [label, value] of [["Dockerfile", build.dockerfile], ["Build context", build.context]] as const) {
    if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
      return { valid: false, error: `${label} must be a safe repository-relative path` };
    }
  }
  if (!BUILD_IMAGE.test(build.image_repository) || build.image_repository.includes("@") || /:[^/]+$/.test(build.image_repository)) {
    return { valid: false, error: "Build image repository must be an OCI repository without a tag or digest" };
  }
  if (build.platform !== undefined && build.platform !== "linux/amd64") {
    return { valid: false, error: "Build platform must be linux/amd64" };
  }
  if (build.cache !== undefined && typeof build.cache !== "boolean") {
    return { valid: false, error: "Build cache must be a boolean" };
  }
  if (!req.git_commit || !/^[0-9a-f]{40,64}$/i.test(req.git_commit)) {
    return { valid: false, error: "OCD builds require an exact 40-64 character Git commit SHA" };
  }
  return validateDeployRequest({
    ...req,
    image_ref: `${build.image_repository}@sha256:${"0".repeat(64)}`,
  });
}
