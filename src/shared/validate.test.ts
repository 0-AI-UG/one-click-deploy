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
  validateComposeWebService,
  validateDeployManifest,
  assertSafeHostPath,
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

describe("validateComposeWebService", () => {
  test("accepts typical compose service names", () => {
    expect(validateComposeWebService("web").valid).toBe(true);
    expect(validateComposeWebService("api_v2").valid).toBe(true);
    expect(validateComposeWebService("Worker-1").valid).toBe(true);
  });

  test("rejects empty / whitespace-only", () => {
    expect(validateComposeWebService("").valid).toBe(false);
    expect(validateComposeWebService("   ").valid).toBe(false);
  });

  test("rejects names starting with hyphen or underscore", () => {
    expect(validateComposeWebService("-web").valid).toBe(false);
    expect(validateComposeWebService("_web").valid).toBe(false);
  });

  test("rejects spaces and special chars", () => {
    expect(validateComposeWebService("my app").valid).toBe(false);
    expect(validateComposeWebService("my.app").valid).toBe(false);
    expect(validateComposeWebService("my/app").valid).toBe(false);
  });

  test("rejects >63 chars", () => {
    expect(validateComposeWebService("a".repeat(64)).valid).toBe(false);
    expect(validateComposeWebService("a".repeat(63)).valid).toBe(true);
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
    expect(validateDeployManifest({ name: "x", build: { compose_file: "sub/../etc/compose.yml" } }).ok).toBe(false);
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
});
