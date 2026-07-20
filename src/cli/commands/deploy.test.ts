import { describe, test, expect } from "bun:test";
import { deriveTarget } from "./deploy.ts";
import type { DeployManifest } from "../../shared/rpc.ts";

// A manifest declaring both a production and a staging target, exercising the
// per-target override fields the CLI maps onto the wire DeployRequest.
const manifest: Pick<DeployManifest, "targets" | "webhook"> = {
  webhook: { enabled: true, branch: "release" },
  targets: {
    production: { branch: "main" },
    staging: {
      branch: "develop",
      replicas: 2,
      domain: "staging.example.com",
      scale_to_zero_after: 300,
    },
  },
};

describe("deriveTarget", () => {
  test("--target=staging derives <name>-staging, target tag, and staging pool", () => {
    const res = deriveTarget(manifest, "staging", "myapp");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      app_name: "myapp-staging",
      target: "staging",
      git_branch: "develop",
      replicas: 2,
      domain: "staging.example.com",
      scale_to_zero_after: 300,
      placement_pool: "staging",
      isProduction: false,
    });
  });

  test("--target=production keeps the bare name, tag production, pool general", () => {
    const res = deriveTarget(manifest, "production", "myapp");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      app_name: "myapp",
      target: "production",
      git_branch: "main",
      placement_pool: "general",
      isProduction: true,
    });
  });

  test("branch precedence: target.branch || webhook.branch || main", () => {
    // Target branch wins.
    let res = deriveTarget(manifest, "staging", "a");
    expect(res.ok && res.value!.git_branch).toBe("develop");
    // No target branch → webhook branch.
    res = deriveTarget(
      { webhook: { enabled: true, branch: "release" }, targets: { staging: {} } },
      "staging",
      "a",
    );
    expect(res.ok && res.value!.git_branch).toBe("release");
    // Neither → main.
    res = deriveTarget({ targets: { staging: {} } }, "staging", "a");
    expect(res.ok && res.value!.git_branch).toBe("main");
  });

  test("isolated: false drops the staging placement pool", () => {
    const res = deriveTarget({ targets: { staging: { isolated: false } } }, "staging", "a");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value!.placement_pool).toBeUndefined();
    // Explicit isolated: true and the default both keep the pool.
    const explicit = deriveTarget({ targets: { staging: { isolated: true } } }, "staging", "a");
    expect(explicit.ok && explicit.value!.placement_pool).toBe("staging");
  });

  test("unknown target errors and lists the declared targets", () => {
    const res = deriveTarget(manifest, "qa", "myapp");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe('Unknown target "qa".');
    expect(res.hint).toContain("production");
    expect(res.hint).toContain("staging");
  });

  test("unknown target with no targets block says so", () => {
    const res = deriveTarget({}, "staging", "myapp");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toBe('The manifest has no "targets" block.');
  });

  test("no --target with no targets block: no target semantics (unchanged behavior)", () => {
    const res = deriveTarget({}, undefined, "myapp");
    expect(res).toEqual({ ok: true, value: null });
  });
});

describe("contract: plain deploy applies a declared production target (T1)", () => {
  // REGRESSION: currently failing by design — pinned desired behavior
  test("no --target with targets.production declared derives exactly like --target=production", () => {
    const m: Pick<DeployManifest, "targets" | "webhook"> = {
      webhook: { enabled: true, branch: "release" },
      targets: {
        production: { branch: "prod-branch", replicas: 3, domain: "www.example.com", scale_to_zero_after: 0 },
      },
    };
    const explicit = deriveTarget(m, "production", "myapp");
    const implicit = deriveTarget(m, undefined, "myapp");
    expect(explicit.ok).toBe(true);
    expect(implicit.ok).toBe(true);
    if (!explicit.ok || !implicit.ok) throw new Error("unreachable");
    // The plain deploy must apply the production target: tag "production",
    // branch from targets.production.branch || webhook.branch || "main",
    // replicas/domain/scale_to_zero_after overrides, placement_pool "general".
    expect(implicit.value).toEqual(explicit.value);
    expect(implicit.value).toEqual({
      app_name: "myapp",
      target: "production",
      git_branch: "prod-branch",
      replicas: 3,
      domain: "www.example.com",
      scale_to_zero_after: 0,
      placement_pool: "general",
      isProduction: true,
    });
  });

  // REGRESSION: currently failing by design — pinned desired behavior
  test("production target's branch falls back to webhook.branch, then main", () => {
    const viaWebhook = deriveTarget(
      { webhook: { enabled: true, branch: "release" }, targets: { production: {} } },
      undefined,
      "myapp",
    );
    expect(viaWebhook.ok && viaWebhook.value?.git_branch).toBe("release");
    const viaDefault = deriveTarget({ targets: { production: {} } }, undefined, "myapp");
    expect(viaDefault.ok && viaDefault.value?.git_branch).toBe("main");
  });
});
