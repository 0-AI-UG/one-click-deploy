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

export function validateDigitalOceanToken(token: string): ValidationResult<string> {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, error: "Token is required" };
  // DO Personal Access Tokens are typically 64-char hex strings, optionally
  // prefixed with `dop_v1_`. Be lenient on length to allow future formats.
  if (trimmed.length < 32)
    return { valid: false, error: "Token is too short (minimum 32 characters)" };
  if (trimmed.length > 256)
    return { valid: false, error: "Token is too long (maximum 256 characters)" };
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
    if ("compose_file" in b && typeof b.compose_file !== "string")
      return { ok: false, error: '"build.compose_file" must be a string' };
    if ("compose_web_service" in b && typeof b.compose_web_service !== "string")
      return { ok: false, error: '"build.compose_web_service" must be a string' };
    if ("context" in b && typeof b.context !== "string")
      return { ok: false, error: '"build.context" must be a string' };
    if ("container_port" in b) {
      if (typeof b.container_port !== "number" || !Number.isInteger(b.container_port) || b.container_port < 1 || b.container_port > 65535)
        return { ok: false, error: '"build.container_port" must be an integer 1–65535' };
    }
    // Reject .. in paths
    for (const key of ["dockerfile", "compose_file"] as const) {
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

  return { ok: true, manifest: raw as import("./rpc.ts").DeployManifest };
}

export function validateDeployRequest(req: {
  app_name: string;
  domain?: string;
  git_repo: string;
  git_branch?: string;
  container_port: number;
  env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
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

  const portResult = validatePort(req.container_port);
  if (!portResult.valid) return { valid: false, error: `Port: ${portResult.error}` };

  if (req.env_vars) {
    const envResult = validateEnvVars(req.env_vars);
    if (!envResult.valid) return { valid: false, error: envResult.error };
  }

  return { valid: true, value: undefined };
}
