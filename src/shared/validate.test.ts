import { describe, test, expect } from "bun:test";
import {
  validateAppName,
  validateGitRepo,
  validateDomain,
  validatePort,
  validateEnvVars,
  validateHetznerToken,
  validateDeployRequest,
} from "./validate.ts";

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
});
