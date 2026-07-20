import { describe, test, expect, spyOn } from "bun:test";
import { validateDeployManifest, validateStackManifest } from "./manifest-validate.ts";
import type { DeployManifest, StackManifest } from "./rpc.ts";

// Compile-time guard: the `z.infer`-derived types must stay structurally
// compatible with how the rest of the codebase reads a manifest (e.g.
// stack-spec.ts reads health_check?.enabled, build?.container_port). If the
// schema drifts from these shapes, this file stops type-checking.
const _deploy: DeployManifest = {
  name: "web",
  build: { container_port: 3000 },
  env: [{ key: "PORT", default: "3000", required: false, secret: false }],
  volume: { size: 5, path: "/data" },
  health_check: { enabled: false, path: "/healthz" },
  internal_protocol: "http",
  public_port: "auto",
  public_protocol: "tcp",
};
const _enabled: boolean | undefined = _deploy.health_check?.enabled;
const _port: number | undefined = _deploy.build?.container_port;
const _stack: StackManifest = {
  name: "s",
  services: { db: { type: "postgres" } },
  apps: { web: { manifest: "web/.ocd-deploy.json", needs: ["db"] } },
};
void _enabled;
void _port;
void _stack;

const validApp = {
  name: "web",
  build: { container_port: 3000 },
  env: [{ key: "PORT", default: "3000" }],
  health_check: { enabled: false },
  internal_protocol: "http" as const,
};

describe("validateDeployManifest", () => {
  test("a correct manifest passes", () => {
    expect(() => validateDeployManifest(validApp, "docker/.ocd-deploy.json")).not.toThrow();
  });

  test("health_check boolean (the incident) fails with a clear message", () => {
    let msg = "";
    try {
      validateDeployManifest({ name: "db", health_check: false }, "docker/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("docker/.ocd-deploy.json");
    expect(msg).toContain("health_check: expected object { enabled?: boolean, path?: string }, got boolean (false)");
  });

  test("bad internal_protocol enum fails", () => {
    let msg = "";
    try {
      validateDeployManifest({ name: "web", internal_protocol: "tpc" }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('internal_protocol: expected "http" | "tcp", got "tpc"');
  });

  test("missing name fails", () => {
    expect(() => validateDeployManifest({}, "a/.ocd-deploy.json")).toThrow(/name:/);
  });

  test("collects multiple issues at once", () => {
    let msg = "";
    try {
      validateDeployManifest({ name: "web", public: "yes", health_check: false }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("public: expected boolean, got \"yes\"");
    expect(msg).toContain("health_check: expected object");
  });

  test("wrong-typed build / container_port fails", () => {
    expect(() => validateDeployManifest({ name: "web", build: { container_port: "3000" } }, "a")).toThrow(
      /build\.container_port: expected integer 1-65535, got "3000"/,
    );
  });

  test("unknown key warns but passes", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ name: "web", futureField: 1 }, "a/.ocd-deploy.json")).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Manifest a/.ocd-deploy.json: unknown key "futureField" (ignored)');
    warn.mockRestore();
  });

  test("targets block + durability_class validates", () => {
    expect(() =>
      validateDeployManifest(
        {
          name: "web",
          durability_class: "high",
          targets: {
            production: { branch: "main" },
            staging: { branch: "develop", replicas: 1, isolated: true, scale_to_zero_after: 300 },
          },
        },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
  });

  test("bad durability_class enum fails", () => {
    let msg = "";
    try {
      validateDeployManifest({ name: "web", durability_class: "gold" }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("durability_class");
  });

  test("wrong-typed replicas in a deploy target fails", () => {
    expect(() =>
      validateDeployManifest(
        { name: "web", targets: { staging: { replicas: "two" } } },
        "a/.ocd-deploy.json",
      ),
    ).toThrow(/replicas/);
  });

  test("neither targets nor durability_class still validates (backward compat)", () => {
    expect(() => validateDeployManifest({ name: "web" }, "a/.ocd-deploy.json")).not.toThrow();
  });

  test("a full targets block parses (isolated, overrides, multiple targets)", () => {
    expect(() =>
      validateDeployManifest(
        {
          name: "web",
          webhook: { enabled: true, branch: "main" },
          targets: {
            production: { branch: "main", replicas: 2, domain: "www.example.com" },
            staging: { branch: "develop", isolated: true, scale_to_zero_after: 600 },
            dev: { isolated: false },
          },
        },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
  });

  test("unknown key inside a target is non-fatal (warns, still passes)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", targets: { staging: { future_knob: 1 } } },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("legacy top-level `environments` key warns but does not throw", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", environments: { staging: { branch: "develop" } } },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
    // Some warning naming the stray key is emitted (exact wording unpinned —
    // the contract upgrades it to a rename hint).
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("environments"))).toBe(true);
    warn.mockRestore();
  });
});

describe("contract: environments → targets rename warning (T3b)", () => {
  // REGRESSION: currently failing by design — pinned desired behavior
  test("top-level `environments` key warns with an explicit rename hint mentioning targets", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", environments: { staging: { branch: "develop" } } },
        "a/.ocd-deploy.json",
      ),
    ).not.toThrow();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    // The warning must mention BOTH the legacy key and the `targets` rename so
    // users know how to migrate (still non-fatal).
    expect(messages.some((m) => m.includes("environments") && m.includes("targets"))).toBe(true);
    warn.mockRestore();
  });
});

describe("validateStackManifest", () => {
  const validStack = {
    name: "myapp",
    services: { db: { type: "postgres" } },
    apps: {
      web: { manifest: "web/.ocd-deploy.json", needs: ["db"] },
      worker: { manifest: "worker/.ocd-deploy.json", needs: ["web"] },
    },
  };

  test("a correct stack passes", () => {
    expect(() => validateStackManifest(validStack, "ocd-stack.json")).not.toThrow();
  });

  test("needs referencing a missing app key fails", () => {
    let msg = "";
    try {
      validateStackManifest(
        { name: "s", apps: { web: { manifest: "web/.ocd-deploy.json", needs: ["ghost"] } } },
        "ocd-stack.json",
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('apps.web.needs[0]: references "ghost", which is not a declared app or service key');
  });

  test("empty apps fails", () => {
    expect(() => validateStackManifest({ name: "s", apps: {} }, "ocd-stack.json")).toThrow(/apps:/);
  });

  test("app entry with non-string manifest fails", () => {
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: 5 } } }, "ocd-stack.json"),
    ).toThrow(/apps\.web\.manifest: expected a manifest path string, got number \(5\)/);
  });

  test("unknown top-level key warns but passes", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: "w" } }, extra: true }, "ocd-stack.json"),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Manifest ocd-stack.json: unknown key "extra" (ignored)');
    warn.mockRestore();
  });
});
