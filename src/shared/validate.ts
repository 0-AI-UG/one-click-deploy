import { publicPortRange, type PublicProtocol } from "./db/apps.ts";

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

export function validateGitRepo(repo: string): ValidationResult<string> {
  const trimmed = repo.trim();
  if (!trimmed) return { valid: false, error: "Git repository URL is required" };

  // Allow https:// and git@ protocols only
  const isHttps = /^https:\/\/[^\s]+$/.test(trimmed);
  const isGitSsh = /^git@[^\s:]+:[^\s]+$/.test(trimmed);
  if (!isHttps && !isGitSsh)
    return {
      valid: false,
      error:
        "Git repository must use https:// or git@ protocol",
    };

  // Reject shell metacharacters that could break command strings
  if (/[;|&`$(){}[\]!#<>\\]/.test(trimmed))
    return {
      valid: false,
      error: "Git repository URL contains invalid characters",
    };

  return { valid: true, value: trimmed };
}

/**
 * Validate a git ref / branch name. Subset of git's ref rules, intentionally
 * strict because the value is interpolated into a shell command on the build
 * host (see deploy.ts `git checkout ${branch}`). Anything that doesn't match
 * this pattern is rejected before reaching the shell.
 *
 * Allowed: ASCII letters, digits, and `_./-` (no leading `-`, `/`, `.`; no
 * `..`; no whitespace or shell metacharacters; <= 244 chars).
 */
export function validateGitBranch(branch: string): ValidationResult<string> {
  const trimmed = branch.trim();
  if (!trimmed) return { valid: false, error: "Branch is required" };
  if (trimmed.length > 244)
    return { valid: false, error: "Branch must be 244 characters or fewer" };
  if (trimmed.startsWith("-") || trimmed.startsWith("/") || trimmed.startsWith("."))
    return { valid: false, error: "Branch must not start with '-', '/', or '.'" };
  if (trimmed.endsWith("/") || trimmed.endsWith("."))
    return { valid: false, error: "Branch must not end with '/' or '.'" };
  if (trimmed.includes(".."))
    return { valid: false, error: "Branch must not contain '..'" };
  if (!/^[A-Za-z0-9_./-]+$/.test(trimmed))
    return {
      valid: false,
      error:
        "Branch may only contain letters, digits, and '_./-'",
    };
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
 * `validateDeployRequest` and `handleUpdateIngressSettings`. Returns the
 * normalized values (or the first error) so both call sites agree on both the
 * rules and the error strings. `httpHealthCheck` is whether the app is (or will
 * be) HTTP-routed — password protection and an active health-check path are
 * Traefik HTTP-router features and can't gate a raw-TCP app.
 */
export function validateIngressFields(
  fields: IngressFieldsInput,
  ctx: { httpHealthCheck: boolean },
): ValidationResult<NormalizedIngressFields> {
  const out: NormalizedIngressFields = {};

  // Password protection is a Traefik basicAuth middleware, which only exists
  // for HTTP routers — a raw-TCP app can't enforce it.
  if (fields.auth_password !== undefined) {
    if (fields.auth_password && !ctx.httpHealthCheck) {
      return { valid: false, error: "Password protection requires the HTTP health check — it is enforced by HTTP basic auth at the ingress and cannot gate raw-TCP apps" };
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
    // raw-TCP apps use a TCP connect check instead.
    if (pathResult.value && !ctx.httpHealthCheck) {
      return { valid: false, error: "Health check path requires the HTTP health check — raw-TCP apps use a TCP connect check instead" };
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

/** Public-router rate limit in requests/second; 0 = unlimited. */
export function isValidRateLimitRps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
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

export function validateComposeWebService(name: string): ValidationResult<string> {
  const trimmed = name.trim();
  if (!trimmed) return { valid: false, error: "Web service name is required" };
  if (trimmed.length > 63)
    return { valid: false, error: "Service name must be 63 characters or fewer" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed))
    return {
      valid: false,
      error: "Service name must start with a letter or digit and contain only letters, digits, hyphens, or underscores",
    };
  return { valid: true, value: trimmed };
}

export function validateDeployManifest(
  raw: unknown,
): { ok: true; manifest: import("./rpc.ts").DeployManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "Manifest must be a JSON object" };

  const obj = raw as Record<string, unknown>;

  if ("$schema" in obj && obj.$schema !== 1)
    return { ok: false, error: "Unsupported $schema version (expected 1)" };

  if ("$llm" in obj && typeof obj.$llm !== "string")
    return { ok: false, error: '"$llm" must be a string' };

  if (typeof obj.name !== "string" || !obj.name.trim())
    return { ok: false, error: '"name" is required and must be a non-empty string' };

  if ("description" in obj && typeof obj.description !== "string")
    return { ok: false, error: '"description" must be a string' };

  if ("icon" in obj && typeof obj.icon !== "string")
    return { ok: false, error: '"icon" must be a string' };

  // build
  if ("build" in obj && obj.build != null) {
    if (typeof obj.build !== "object" || Array.isArray(obj.build))
      return { ok: false, error: '"build" must be an object' };
    const b = obj.build as Record<string, unknown>;
    if ("dockerfile" in b && typeof b.dockerfile !== "string")
      return { ok: false, error: '"build.dockerfile" must be a string' };
    if ("context" in b && typeof b.context !== "string")
      return { ok: false, error: '"build.context" must be a string' };
    if ("container_port" in b) {
      if (typeof b.container_port !== "number" || !Number.isInteger(b.container_port) || b.container_port < 1 || b.container_port > 65535)
        return { ok: false, error: '"build.container_port" must be an integer 1–65535' };
    }
    // Reject .. in paths
    for (const key of ["dockerfile"] as const) {
      if (typeof b[key] === "string" && (b[key] as string).includes(".."))
        return { ok: false, error: `"build.${key}" must not contain ".."` };
    }
  }

  // env
  if ("env" in obj && obj.env != null) {
    if (!Array.isArray(obj.env))
      return { ok: false, error: '"env" must be an array' };
    for (let i = 0; i < obj.env.length; i++) {
      const e = obj.env[i];
      if (!e || typeof e !== "object")
        return { ok: false, error: `env[${i}] must be an object` };
      if (typeof e.key !== "string" || !ENV_KEY_PATTERN.test(e.key))
        return { ok: false, error: `env[${i}].key "${e.key ?? ""}" is invalid` };
      if ("description" in e && typeof e.description !== "string")
        return { ok: false, error: `env[${i}].description must be a string` };
      if ("default" in e && typeof e.default !== "string")
        return { ok: false, error: `env[${i}].default must be a string` };
    }
  }

  // volume
  if ("volume" in obj && obj.volume != null) {
    if (typeof obj.volume !== "object" || Array.isArray(obj.volume))
      return { ok: false, error: '"volume" must be an object' };
    const v = obj.volume as Record<string, unknown>;
    if ("size" in v && (typeof v.size !== "number" || v.size < 1))
      return { ok: false, error: '"volume.size" must be a positive number' };
    if ("path" in v && (typeof v.path !== "string" || !v.path.startsWith("/")))
      return { ok: false, error: '"volume.path" must start with "/"' };
  }

  // webhook
  if ("webhook" in obj && obj.webhook != null) {
    if (typeof obj.webhook !== "object" || Array.isArray(obj.webhook))
      return { ok: false, error: '"webhook" must be an object' };
  }

  if ("suggested_app_name" in obj && typeof obj.suggested_app_name !== "string")
    return { ok: false, error: '"suggested_app_name" must be a string' };

  if ("replicas" in obj && (typeof obj.replicas !== "number" || obj.replicas < 1))
    return { ok: false, error: '"replicas" must be a positive number' };

  if ("memory_mb" in obj && !isValidMemoryMb(obj.memory_mb))
    return { ok: false, error: `"memory_mb" must be an integer 0 (default) or ${MIN_MEMORY_MB}–${MAX_MEMORY_MB}` };

  if ("health_check" in obj && typeof obj.health_check !== "boolean")
    return { ok: false, error: '"health_check" must be a boolean' };

  return { ok: true, manifest: raw as import("./rpc.ts").DeployManifest };
}

/** Per-app container memory ceiling bounds (MB). 0 means "platform default". */
export const MIN_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 32768;

export function isValidMemoryMb(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 || (value >= MIN_MEMORY_MB && value <= MAX_MEMORY_MB))
  );
}

export function validateDeployRequest(req: {
  app_name: string;
  domain?: string;
  git_repo: string;
  git_branch?: string;
  container_port: number;
  env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
  memory_mb?: number;
  public?: boolean;
  auth_password?: string;
  health_check?: boolean;
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean;
  public_port?: number | "auto" | null;
  public_protocol?: string;
}): ValidationResult<void> {
  const nameResult = validateAppName(req.app_name);
  if (!nameResult.valid) return { valid: false, error: `App name: ${nameResult.error}` };

  const repoResult = validateGitRepo(req.git_repo);
  if (!repoResult.valid) return { valid: false, error: `Git repo: ${repoResult.error}` };

  if (req.git_branch) {
    const branchResult = validateGitBranch(req.git_branch);
    if (!branchResult.valid) return { valid: false, error: `Git branch: ${branchResult.error}` };
  }

  if (req.domain) {
    const domainResult = validateDomain(req.domain);
    if (!domainResult.valid) return { valid: false, error: `Domain: ${domainResult.error}` };
  }

  if (req.public === false && req.domain) {
    return { valid: false, error: "Private apps cannot have a public domain — remove `domain` or set `public: true`" };
  }

  const portResult = validatePort(req.container_port);
  if (!portResult.valid) return { valid: false, error: `Port: ${portResult.error}` };

  if (req.env_vars) {
    const envResult = validateEnvVars(req.env_vars);
    if (!envResult.valid) return { valid: false, error: envResult.error };
  }

  if (req.memory_mb !== undefined && !isValidMemoryMb(req.memory_mb)) {
    return { valid: false, error: `Memory: must be an integer 0 (default) or ${MIN_MEMORY_MB}–${MAX_MEMORY_MB} MB` };
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
    { httpHealthCheck: req.health_check !== false },
  );
  if (!ingressResult.valid) return { valid: false, error: ingressResult.error };

  return { valid: true, value: undefined };
}
