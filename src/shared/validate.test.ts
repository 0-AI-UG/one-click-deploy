import { describe, test, expect } from "bun:test";
import {
  validateAppName,
  validateGitRepo,
  validateDomain,
  validatePort,
  validateEnvVars,
  validateHetznerToken,
  validateDeployRequest,
  validateGitHubPat,
  validateDeployManifest,
  assertSafeHostPath,
  validateIpAllowlist,
  validateHealthCheckPath,
  validatePublicPort,
  isPublicProtocol,
  validateIngressFields,
  validateRepoBuildPath,
} from "./validate.ts";

describe("assertSafeHostPath", () => {
  test("accepts per-app volume root", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/data", "myapp")).not.toThrow();
  });
  test("accepts block-storage prefix", () => {
    expect(() => assertSafeHostPath("/mnt/ocd-myapp-data", "myapp")).not.toThrow();
  });
  test("accepts per-service volume root", () => {
    expect(() => assertSafeHostPath("/home/deploy/services/postgres/data", "postgres")).not.toThrow();
  });
  test("rejects /etc", () => {
    expect(() => assertSafeHostPath("/etc/passwd", "myapp")).toThrow(/allowlist/);
  });
  test("rejects another app's dir", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/other/volumes/data", "myapp")).toThrow(/allowlist/);
  });
  test("rejects ..", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/../../../etc", "myapp")).toThrow(/'\.\.'/);
  });
  test("rejects relative paths", () => {
    expect(() => assertSafeHostPath("relative/path", "myapp")).toThrow(/absolute/);
  });
  test("rejects whitespace / injection chars", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/x y", "myapp")).toThrow(/invalid/);
  });
  test("rejects unsafe app name", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/x/volumes/data", "../etc")).toThrow(/Invalid app name/);
  });
});

describe("validateAppName", () => {
  test("accepts valid names", () => {
    expect(validateAppName("my-app").valid).toBe(true);
    expect(validateAppName("app123").valid).toBe(true);
    expect(validateAppName("a").valid).toBe(true);
    expect(validateAppName("a1").valid).toBe(true);
  });

  test("trims and lowercases", () => {
    const result = validateAppName("  My-App  ");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe("my-app");
  });

  test("rejects empty", () => {
    expect(validateAppName("").valid).toBe(false);
    expect(validateAppName("   ").valid).toBe(false);
  });

  test("rejects names longer than 63 chars", () => {
    expect(validateAppName("a".repeat(64)).valid).toBe(false);
  });

  test("rejects names starting/ending with hyphen", () => {
    expect(validateAppName("-app").valid).toBe(false);
    expect(validateAppName("app-").valid).toBe(false);
  });

  test("rejects consecutive hyphens", () => {
    expect(validateAppName("my--app").valid).toBe(false);
  });

  test("rejects special characters", () => {
    expect(validateAppName("my_app").valid).toBe(false);
    expect(validateAppName("my app").valid).toBe(false);
    expect(validateAppName("my.app").valid).toBe(false);
  });
});

describe("validateRepoBuildPath", () => {
  test("accepts repository-relative Docker paths", () => {
    expect(validateRepoBuildPath("apps/api/Dockerfile", "Dockerfile")).toEqual({
      valid: true,
      value: "apps/api/Dockerfile",
    });
    expect(validateRepoBuildPath(".", "Docker context").valid).toBe(true);
  });

  test("rejects absolute, traversing, and shell-unsafe paths", () => {
    expect(validateRepoBuildPath("/etc/passwd", "Dockerfile").valid).toBe(false);
    expect(validateRepoBuildPath("apps/../Dockerfile", "Dockerfile").valid).toBe(false);
    expect(validateRepoBuildPath("Dockerfile;reboot", "Dockerfile").valid).toBe(false);
  });
});

describe("validateGitRepo", () => {
  test("accepts HTTPS URLs", () => {
    expect(validateGitRepo("https://github.com/user/repo.git").valid).toBe(true);
    expect(validateGitRepo("https://gitlab.com/user/repo").valid).toBe(true);
  });

  test("accepts git@ SSH URLs", () => {
    expect(validateGitRepo("git@github.com:user/repo.git").valid).toBe(true);
  });

  test("rejects empty", () => {
    expect(validateGitRepo("").valid).toBe(false);
  });

  test("rejects file:// protocol", () => {
    expect(validateGitRepo("file:///etc/passwd").valid).toBe(false);
  });

  test("rejects plain text", () => {
    expect(validateGitRepo("just-a-string").valid).toBe(false);
  });

  test("rejects shell metacharacters", () => {
    expect(validateGitRepo("https://github.com/user/repo;rm -rf /").valid).toBe(false);
    expect(validateGitRepo("https://github.com/user/repo$(whoami)").valid).toBe(false);
    expect(validateGitRepo("https://github.com/user/repo`id`").valid).toBe(false);
    expect(validateGitRepo("https://github.com/user/repo|cat /etc/passwd").valid).toBe(false);
  });
});

describe("validateDomain", () => {
  test("accepts valid domains", () => {
    expect(validateDomain("example.com").valid).toBe(true);
    expect(validateDomain("sub.example.com").valid).toBe(true);
    expect(validateDomain("my-app.example.co.uk").valid).toBe(true);
  });

  test("lowercases", () => {
    const result = validateDomain("Example.COM");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe("example.com");
  });

  test("rejects single label", () => {
    expect(validateDomain("localhost").valid).toBe(false);
  });

  test("rejects empty labels", () => {
    expect(validateDomain("example..com").valid).toBe(false);
  });

  test("rejects labels over 63 chars", () => {
    expect(validateDomain("a".repeat(64) + ".com").valid).toBe(false);
  });

  test("rejects domains over 253 chars", () => {
    const long = Array(30).fill("abcdefghij").join(".") + ".com";
    expect(validateDomain(long).valid).toBe(false);
  });

  test("rejects labels with special chars", () => {
    expect(validateDomain("my_app.com").valid).toBe(false);
    expect(validateDomain("my app.com").valid).toBe(false);
  });
});

describe("validatePort", () => {
  test("accepts valid ports", () => {
    expect(validatePort(80).valid).toBe(true);
    expect(validatePort(3000).valid).toBe(true);
    expect(validatePort(65535).valid).toBe(true);
    expect(validatePort(1).valid).toBe(true);
  });

  test("rejects out of range", () => {
    expect(validatePort(0).valid).toBe(false);
    expect(validatePort(-1).valid).toBe(false);
    expect(validatePort(65536).valid).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(validatePort(3.14).valid).toBe(false);
  });
});

describe("validateEnvVars", () => {
  test("accepts valid env vars", () => {
    expect(validateEnvVars({ NODE_ENV: "production", PORT: "3000" }).valid).toBe(true);
    expect(validateEnvVars({ _VAR: "value" }).valid).toBe(true);
    expect(validateEnvVars({}).valid).toBe(true);
  });

  test("rejects invalid key format", () => {
    expect(validateEnvVars({ "123": "val" }).valid).toBe(false);
    expect(validateEnvVars({ "key with spaces": "val" }).valid).toBe(false);
    expect(validateEnvVars({ "key-with-dash": "val" }).valid).toBe(false);
  });

  test("rejects reserved prefixes", () => {
    expect(validateEnvVars({ PATH: "val" }).valid).toBe(false);
    expect(validateEnvVars({ HOME: "val" }).valid).toBe(false);
    expect(validateEnvVars({ DOCKER_HOST: "val" }).valid).toBe(false);
    expect(validateEnvVars({ LD_PRELOAD: "val" }).valid).toBe(false);
  });

  test("rejects null bytes in values", () => {
    expect(validateEnvVars({ KEY: "val\0ue" }).valid).toBe(false);
  });
});

describe("validateHetznerToken", () => {
  test("accepts valid tokens", () => {
    expect(validateHetznerToken("a".repeat(32)).valid).toBe(true);
    expect(validateHetznerToken("a".repeat(64)).valid).toBe(true);
    expect(validateHetznerToken("a".repeat(128)).valid).toBe(true);
  });

  test("rejects empty", () => {
    expect(validateHetznerToken("").valid).toBe(false);
  });

  test("rejects too short", () => {
    expect(validateHetznerToken("short").valid).toBe(false);
  });

  test("rejects too long", () => {
    expect(validateHetznerToken("a".repeat(129)).valid).toBe(false);
  });

  test("rejects non-printable characters", () => {
    expect(validateHetznerToken("a".repeat(31) + "\x01").valid).toBe(false);
  });
});

describe("validateDeployRequest", () => {
  const validRequest = {
    app_name: "my-app",
    git_repo: "https://github.com/user/repo.git",
    container_port: 3000,
    env_vars: { NODE_ENV: "production" },
  };

  test("accepts valid request", () => {
    expect(validateDeployRequest(validRequest).valid).toBe(true);
  });

  test("accepts with optional domain", () => {
    expect(validateDeployRequest({ ...validRequest, domain: "app.example.com" }).valid).toBe(true);
  });

  test("rejects invalid app name", () => {
    expect(validateDeployRequest({ ...validRequest, app_name: "" }).valid).toBe(false);
  });

  test("rejects invalid git repo", () => {
    expect(validateDeployRequest({ ...validRequest, git_repo: "not-a-url" }).valid).toBe(false);
  });

  test("rejects unsafe build paths and malformed immutable commits", () => {
    expect(validateDeployRequest({ ...validRequest, dockerfile_path: "../Dockerfile" }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, docker_context: "/tmp" }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, git_sha: "not-a-sha" }).valid).toBe(false);
  });

  test("rejects invalid port", () => {
    expect(validateDeployRequest({ ...validRequest, container_port: 0 }).valid).toBe(false);
  });

  test("rejects invalid env vars", () => {
    expect(validateDeployRequest({ ...validRequest, env_vars: { PATH: "/bin" } }).valid).toBe(false);
  });

  test("rejects invalid domain", () => {
    expect(validateDeployRequest({ ...validRequest, domain: "not valid" }).valid).toBe(false);
  });

  test("accepts memory_mb of 0 (platform default)", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 0 }).valid).toBe(true);
  });

  test("accepts memory_mb within bounds", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 1024 }).valid).toBe(true);
  });

  test("rejects memory_mb below minimum", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 64 }).valid).toBe(false);
  });

  test("rejects non-integer memory_mb", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 512.5 }).valid).toBe(false);
  });

  test("rejects memory_mb above maximum", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 99999 }).valid).toBe(false);
  });

  test("accepts cpu_limit of 0 (platform default)", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0 }).valid).toBe(true);
  });

  test("accepts fractional cpu_limit within bounds", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.5 }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 2 }).valid).toBe(true);
  });

  test("rejects cpu_limit below minimum", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.05 }).valid).toBe(false);
  });

  test("rejects cpu_limit above maximum", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 64 }).valid).toBe(false);
  });

  test("rejects cpu_limit with nonsense precision", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.333333 }).valid).toBe(false);
  });

  test("rejects auth_password on a raw-TCP app (internal_protocol: tcp)", () => {
    expect(validateDeployRequest({ ...validRequest, auth_password: "pw", internal_protocol: "tcp" }).valid).toBe(false);
  });

  test("accepts auth_password on an HTTP-routed app regardless of the probe flag", () => {
    // Decoupled: internal_protocol defaults to http, so health_check:false no
    // longer implies tcp routing — auth is allowed in every combination below.
    expect(validateDeployRequest({ ...validRequest, auth_password: "pw" }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, auth_password: "pw", health_check: true }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, auth_password: "pw", health_check: false }).valid).toBe(true);
  });

  test("internal_protocol must be http or tcp", () => {
    expect(validateDeployRequest({ ...validRequest, internal_protocol: "http" }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, internal_protocol: "tcp" }).valid).toBe(true);
    const r = validateDeployRequest({ ...validRequest, internal_protocol: "grpc" as any });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/internal protocol must be/i);
  });

  test("rejects auth_password when internal_protocol is tcp (even with the HTTP probe on)", () => {
    // Decoupling: the auth rule now keys off routing, not the probe flag.
    const r = validateDeployRequest({ ...validRequest, auth_password: "pw", internal_protocol: "tcp", health_check: true });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/requires HTTP internal routing/i);
  });

  test("http routing allows auth even with the HTTP probe disabled", () => {
    // Routing and probe are independent: http routing permits basic auth
    // regardless of health_check.
    expect(validateDeployRequest({ ...validRequest, auth_password: "pw", internal_protocol: "http", health_check: false }).valid).toBe(true);
  });

  test("rejects a private app with a domain", () => {
    const r = validateDeployRequest({ ...validRequest, public: false, domain: "app.example.com" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/private apps cannot have a public domain/i);
  });

  test("accepts a private app without a domain", () => {
    expect(validateDeployRequest({ ...validRequest, public: false }).valid).toBe(true);
  });

  test("accepts the per-app ingress settings when valid", () => {
    expect(validateDeployRequest({
      ...validRequest,
      sticky: true,
      rate_limit_rps: 100,
      ip_allowlist: "10.0.0.0/8, 203.0.113.7",
      health_check_path: "/healthz",
      compress: true,
    }).valid).toBe(true);
  });

  test("rejects a bad rate limit (negative / non-integer)", () => {
    expect(validateDeployRequest({ ...validRequest, rate_limit_rps: -1 }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, rate_limit_rps: 1.5 }).valid).toBe(false);
  });

  test("rejects a garbage IP allowlist", () => {
    const r = validateDeployRequest({ ...validRequest, ip_allowlist: "not-an-ip" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/ip allowlist/i);
  });

  test("rejects a health check path that doesn't start with /", () => {
    const r = validateDeployRequest({ ...validRequest, health_check_path: "healthz" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/must start with/i);
  });

  test("rejects health_check_path on a raw-TCP app (internal_protocol: tcp)", () => {
    expect(validateDeployRequest({ ...validRequest, health_check_path: "/healthz", internal_protocol: "tcp" }).valid).toBe(false);
  });

  test("accepts public raw exposure: auto or an in-range port, even for HTTP-private apps", () => {
    expect(validateDeployRequest({ ...validRequest, public_port: "auto" as const }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, public_port: 30001, public_protocol: "tcp" }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, public_port: 30051, public_protocol: "udp" }).valid).toBe(true);
    // Raw exposure is independent of HTTP publicness.
    expect(validateDeployRequest({ ...validRequest, public: false, public_port: "auto" as const }).valid).toBe(true);
  });

  test("rejects a public port outside the protocol's pool or a bad protocol", () => {
    expect(validateDeployRequest({ ...validRequest, public_port: 30051 }).valid).toBe(false); // udp block, tcp default
    expect(validateDeployRequest({ ...validRequest, public_port: 30001, public_protocol: "udp" }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, public_port: 8080 }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, public_port: "auto" as const, public_protocol: "sctp" }).valid).toBe(false);
  });
});

describe("validatePublicPort / isPublicProtocol", () => {
  test("bounds per protocol", () => {
    expect(validatePublicPort(30000, "tcp").valid).toBe(true);
    expect(validatePublicPort(30049, "tcp").valid).toBe(true);
    expect(validatePublicPort(30050, "tcp").valid).toBe(false);
    expect(validatePublicPort(30050, "udp").valid).toBe(true);
    expect(validatePublicPort(30099, "udp").valid).toBe(true);
    expect(validatePublicPort(30100, "udp").valid).toBe(false);
    expect(validatePublicPort(29999, "tcp").valid).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(validatePublicPort(30000.5, "tcp").valid).toBe(false);
    expect(validatePublicPort("30000", "tcp").valid).toBe(false);
    expect(validatePublicPort(null, "tcp").valid).toBe(false);
  });

  test("isPublicProtocol accepts only tcp/udp", () => {
    expect(isPublicProtocol("tcp")).toBe(true);
    expect(isPublicProtocol("udp")).toBe(true);
    expect(isPublicProtocol("sctp")).toBe(false);
    expect(isPublicProtocol(undefined)).toBe(false);
  });
});

describe("validateIpAllowlist", () => {
  test("accepts IPv4 addresses and CIDRs, normalizing whitespace", () => {
    const r = validateIpAllowlist(" 203.0.113.7 , 10.0.0.0/8,192.168.1.0/24 ");
    expect(r).toEqual({ valid: true, value: "203.0.113.7,10.0.0.0/8,192.168.1.0/24" });
  });

  test("accepts IPv6 addresses and CIDRs", () => {
    expect(validateIpAllowlist("2001:db8::1").valid).toBe(true);
    expect(validateIpAllowlist("2001:db8::/32").valid).toBe(true);
    expect(validateIpAllowlist("::1").valid).toBe(true);
    expect(validateIpAllowlist("fe80:0:0:0:0:0:0:1").valid).toBe(true);
  });

  test("empty string means allowlist off", () => {
    expect(validateIpAllowlist("")).toEqual({ valid: true, value: "" });
    expect(validateIpAllowlist(" , ")).toEqual({ valid: true, value: "" });
  });

  test("rejects garbage entries", () => {
    expect(validateIpAllowlist("example.com").valid).toBe(false);
    expect(validateIpAllowlist("10.0.0.0/8; rm -rf /").valid).toBe(false);
    expect(validateIpAllowlist("1.2.3").valid).toBe(false);
    expect(validateIpAllowlist("1.2.3.256").valid).toBe(false);
    expect(validateIpAllowlist("10.0.0.1, banana").valid).toBe(false);
    expect(validateIpAllowlist("2001:db8:::1").valid).toBe(false);
    expect(validateIpAllowlist("1:2:3").valid).toBe(false);
  });

  test("rejects out-of-range prefixes", () => {
    expect(validateIpAllowlist("10.0.0.0/33").valid).toBe(false);
    expect(validateIpAllowlist("2001:db8::/129").valid).toBe(false);
    expect(validateIpAllowlist("10.0.0.0/8/8").valid).toBe(false);
  });
});

describe("validateHealthCheckPath", () => {
  test("accepts an absolute path and trims it", () => {
    expect(validateHealthCheckPath(" /healthz ")).toEqual({ valid: true, value: "/healthz" });
    expect(validateHealthCheckPath("/api/v1/health?deep=1").valid).toBe(true);
  });

  test("empty means disabled", () => {
    expect(validateHealthCheckPath("")).toEqual({ valid: true, value: "" });
  });

  test("rejects relative paths and embedded whitespace", () => {
    expect(validateHealthCheckPath("healthz").valid).toBe(false);
    expect(validateHealthCheckPath("/health z").valid).toBe(false);
  });

  test("rejects overlong paths", () => {
    expect(validateHealthCheckPath("/" + "a".repeat(200)).valid).toBe(false);
  });
});

describe("validateGitHubPat", () => {
  test("accepts a realistic-shaped classic PAT (40 hex chars)", () => {
    const r = validateGitHubPat("a".repeat(40));
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toBe("a".repeat(40));
  });

  test("accepts a fine-grained token with underscores (github_pat_... form)", () => {
    const tok = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
    expect(validateGitHubPat(tok).valid).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    const r = validateGitHubPat("   " + "x".repeat(40) + "  ");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toBe("x".repeat(40));
  });

  test("rejects empty", () => {
    expect(validateGitHubPat("").valid).toBe(false);
    expect(validateGitHubPat("   ").valid).toBe(false);
  });

  test("rejects too short (<30 chars)", () => {
    expect(validateGitHubPat("x".repeat(29)).valid).toBe(false);
  });

  test("rejects too long (>256 chars)", () => {
    expect(validateGitHubPat("x".repeat(257)).valid).toBe(false);
  });

  test("rejects embedded non-printable chars (NUL, tab)", () => {
    expect(validateGitHubPat("x".repeat(20) + "\0" + "x".repeat(20)).valid).toBe(false);
    expect(validateGitHubPat("x".repeat(20) + "\t" + "x".repeat(20)).valid).toBe(false);
  });
});

describe("validateDeployManifest", () => {
  test("accepts a minimal manifest (just name)", () => {
    const r = validateDeployManifest({ name: "demo" });
    expect(r.ok).toBe(true);
  });

  test("accepts a full manifest", () => {
    const r = validateDeployManifest({
      $schema: 1,
      name: "app",
      description: "desc",
      build: { dockerfile: "Dockerfile", context: ".", container_port: 3000 },
      env: [{ key: "DATABASE_URL", required: true }, { key: "API_KEY", secret: true, default: "" }],
      volume: { size: 5, path: "/data" },
      webhook: { enabled: true, branch: "main" },
      replicas: 3,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-object raw inputs", () => {
    expect(validateDeployManifest(null).ok).toBe(false);
    expect(validateDeployManifest([]).ok).toBe(false);
    expect(validateDeployManifest("string").ok).toBe(false);
  });

  test("rejects missing / empty name", () => {
    expect(validateDeployManifest({}).ok).toBe(false);
    expect(validateDeployManifest({ name: "" }).ok).toBe(false);
    expect(validateDeployManifest({ name: "   " }).ok).toBe(false);
    expect(validateDeployManifest({ name: 42 }).ok).toBe(false);
  });

  test("rejects wrong $schema version", () => {
    const r = validateDeployManifest({ $schema: 2, name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/schema/i);
  });

  test("accepts a valid memory_mb", () => {
    expect(validateDeployManifest({ name: "x", memory_mb: 2048 }).ok).toBe(true);
    expect(validateDeployManifest({ name: "x", memory_mb: 0 }).ok).toBe(true);
  });

  test("rejects an out-of-range memory_mb", () => {
    const r = validateDeployManifest({ name: "x", memory_mb: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/memory_mb/);
  });

  test("rejects non-integer container_port", () => {
    expect(validateDeployManifest({ name: "x", build: { container_port: 3.14 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", build: { container_port: 0 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", build: { container_port: 99999 } }).ok).toBe(false);
  });

  test("rejects build paths containing .. (path traversal)", () => {
    expect(validateDeployManifest({ name: "x", build: { dockerfile: "../evil/Dockerfile" } }).ok).toBe(false);
  });

  test("rejects env entries with invalid keys", () => {
    expect(validateDeployManifest({ name: "x", env: [{ key: "1BAD" }] }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", env: [{ key: "has-dash" }] }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", env: "not-an-array" }).ok).toBe(false);
  });

  test("rejects volume with invalid size / non-absolute path", () => {
    expect(validateDeployManifest({ name: "x", volume: { size: 0 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", volume: { size: -1 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", volume: { path: "data" } }).ok).toBe(false);
  });

  test("rejects replicas <1", () => {
    expect(validateDeployManifest({ name: "x", replicas: 0 }).ok).toBe(false);
  });

  test("accepts a full ingress manifest", () => {
    const r = validateDeployManifest({
      name: "x",
      internal_protocol: "http",
      sticky: true,
      rate_limit_rps: 100,
      ip_allowlist: "10.0.0.0/8, 203.0.113.7",
      health_check: { enabled: true, path: "/healthz" },
      compress: true,
      public_port: 30001,
      public_protocol: "tcp",
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-boolean sticky / compress", () => {
    expect(validateDeployManifest({ name: "x", sticky: "yes" }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", compress: 1 }).ok).toBe(false);
  });

  test("rejects an invalid rate_limit_rps / ip_allowlist / health_check.path", () => {
    expect(validateDeployManifest({ name: "x", rate_limit_rps: -1 }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", ip_allowlist: "not-an-ip" }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", health_check: { path: "healthz" } }).ok).toBe(false);
  });

  test("rejects a malformed health_check object", () => {
    expect(validateDeployManifest({ name: "x", health_check: true }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", health_check: { enabled: "yes" } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", health_check: { path: 1 } }).ok).toBe(false);
  });

  test("accepts a nested health_check with enabled and path", () => {
    expect(validateDeployManifest({ name: "x", health_check: { enabled: false } }).ok).toBe(true);
    expect(validateDeployManifest({ name: "x", health_check: { path: "/healthz" } }).ok).toBe(true);
    expect(validateDeployManifest({ name: "x", health_check: {} }).ok).toBe(true);
  });

  test("rejects health_check.path on a raw-TCP manifest", () => {
    expect(validateDeployManifest({ name: "x", internal_protocol: "tcp", health_check: { path: "/healthz" } }).ok).toBe(false);
    // Decoupled: enabled:false no longer implies tcp routing (defaults to http),
    // so a path alongside a disabled probe is accepted at the routing rule.
    expect(validateDeployManifest({ name: "x", health_check: { enabled: false, path: "/healthz" } }).ok).toBe(true);
  });

  test("rejects a public_port outside its protocol pool", () => {
    expect(validateDeployManifest({ name: "x", public_port: 30051, public_protocol: "tcp" }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", public_port: "auto" }).ok).toBe(true);
    expect(validateDeployManifest({ name: "x", public_protocol: "sctp" }).ok).toBe(false);
  });
});

describe("validateIngressFields (shared by deploy + ingress endpoint)", () => {
  test("normalizes allowlist and health path, passes through rate limit", () => {
    const r = validateIngressFields(
      { ip_allowlist: " 10.0.0.0/8 , 203.0.113.7 ", health_check_path: " /healthz ", rate_limit_rps: 100 },
      { httpRouted: true },
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.value.ip_allowlist).toBe("10.0.0.0/8,203.0.113.7");
      expect(r.value.health_check_path).toBe("/healthz");
      expect(r.value.rate_limit_rps).toBe(100);
    }
  });

  test("password + health-path require HTTP routing (httpRouted=false rejects)", () => {
    expect(validateIngressFields({ auth_password: "pw" }, { httpRouted: false }).valid).toBe(false);
    expect(validateIngressFields({ health_check_path: "/healthz" }, { httpRouted: false }).valid).toBe(false);
    // Empty values don't trip the gate.
    expect(validateIngressFields({ auth_password: "" }, { httpRouted: false }).valid).toBe(true);
    expect(validateIngressFields({ health_check_path: "" }, { httpRouted: false }).valid).toBe(true);
  });

  test("deploy and ingress agree: same rule yields the same error string", () => {
    const viaDeploy = validateDeployRequest({
      app_name: "a", git_repo: "https://github.com/x/y.git", container_port: 3000,
      auth_password: "pw", internal_protocol: "tcp",
    });
    const viaHelper = validateIngressFields({ auth_password: "pw" }, { httpRouted: false });
    expect(viaDeploy.valid).toBe(false);
    expect(viaHelper.valid).toBe(false);
    if (!viaDeploy.valid && !viaHelper.valid) expect(viaDeploy.error).toBe(viaHelper.error);
  });

  test("range-checks public port against the resolved protocol", () => {
    expect(validateIngressFields({ public_port: 30001, public_protocol: "tcp" }, { httpRouted: true }).valid).toBe(true);
    expect(validateIngressFields({ public_port: 30001, public_protocol: "udp" }, { httpRouted: true }).valid).toBe(false);
    expect(validateIngressFields({ public_protocol: "sctp" }, { httpRouted: true }).valid).toBe(false);
    expect(validateIngressFields({ public_port: "auto" }, { httpRouted: true }).valid).toBe(true);
  });
});
