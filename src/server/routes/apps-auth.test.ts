import { useTempDataDir, seedTestAdmin } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";

const realPermissions = await import("../lib/permissions.ts");
const { PermissionError } = await import("../lib/errors.ts");
const testPayload = (request: Request) => ({
  userId: seedTestAdmin(),
  username: "admin",
  ...(request.headers.get("x-test-client") === "browser" ? {} : { client: "cli" as const }),
});
mock.module("../lib/permissions.ts", () => ({
  ...realPermissions,
  requireAdmin: async () => ({ userId: seedTestAdmin(), username: "admin" }),
  requirePermission: async (request: Request) => testPayload(request),
  requireCliPermission: async (request: Request) => {
    const payload = testPayload(request);
    if (payload.client !== "cli") {
      throw new PermissionError("This action is only available through the ocd CLI");
    }
    return payload;
  },
  requireAuthenticated: async () => ({ userId: seedTestAdmin(), username: "admin" }),
}));

mock.module("../../engine/scale/traefik-manager.ts", () => ({
  syncAppIngress: async () => {},
  getPanelIngressIpv4: () => "203.0.113.9",
}));

import * as db from "../../shared/db.ts";
import { handleDeploy, handleGetApps } from "./apps.ts";

function makeApp(overrides: Partial<Parameters<typeof db.insertApp>[0]> = {}) {
  return db.insertApp({
    name: `app-${Math.random().toString(36).slice(2, 8)}`,
    domain: "gated.example.com",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    health_check: true,
    ...overrides,
  });
}

function deployRequest(
  app: ReturnType<typeof makeApp>,
  overrides: Record<string, unknown> = {},
  client: "cli" | "browser" = "cli",
) {
  return new Request("http://x/api/apps/deploy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-client": client },
    body: JSON.stringify({
      app_name: app.name,
      apply_mode: "manifest",
      git_repo: app.git_repo,
      container_port: app.container_port,
      volume_id: "",
      volume_size: 0,
      volume_path: "/data",
      deploy: false,
      ...overrides,
    }),
  });
}

describe("app response scrubbing", () => {
  test("secrets never leave the server; auth_enabled is derived", async () => {
    const app = makeApp({ auth_password: "hunter2" });
    db.updateAppWebhook(app.id, true, "whsec_shhh", "main", "gh-1");
    db.updateAppSleepingState(app.id, 1, 10001);

    const response = await handleGetApps(new Request("http://x/api/apps"));
    const row = ((await response.json()) as Array<Record<string, unknown>>).find((candidate) => candidate.id === app.id)!;
    expect(row).not.toHaveProperty("auth_password");
    expect(row).not.toHaveProperty("auth_password_hash");
    expect(row).not.toHaveProperty("wake_token");
    expect(row).not.toHaveProperty("webhook_secret");
    expect(row.env_vars).toEqual([]);
    expect(row.auth_enabled).toBe(true);
  });
});

describe("CLI-only manifest endpoint", () => {
  test("rejects browser clients even when authenticated", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, {}, "browser"));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/only available through the ocd CLI/i);
  });

  test("requires manifest apply mode", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, { apply_mode: undefined }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('apply_mode must be "manifest"');
  });

  test("rejects the removed patch mode", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, { apply_mode: "patch" }));
    expect(response.status).toBe(400);
  });

  test("config-only applies a complete manifest and documented defaults", async () => {
    const app = makeApp({ sticky: true, auth_password: "hunter2" });
    db.updateAppMemory(app.id, 1024);

    const response = await handleDeploy(deployRequest(app));
    expect(response.status).toBe(200);
    const body = await response.json() as { applied: boolean; op_id: number | null };
    expect(body.applied).toBe(true);
    expect(body.op_id).toBeNumber();

    const updated = db.getApp(app.id)!;
    expect(updated.sticky).toBe(0);
    expect(updated.memory_mb).toBe(0);
    expect(updated.auth_password_hash).toBe("");
  });

  test("manifest password inputs remain write-only", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, { auth_password: "s3cret" }));
    expect(response.status).toBe(200);
    const updated = db.getApp(app.id)!;
    expect(updated.auth_password_hash).not.toBe("s3cret");
    expect(Bun.password.verifySync("s3cret", updated.auth_password_hash)).toBe(true);
  });

  test("rejects HTTP auth for a raw TCP manifest", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, {
      internal_protocol: "tcp",
      auth_password: "s3cret",
    }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/requires HTTP internal routing/i);
  });

  test("dry-run reports changes without applying them", async () => {
    const app = makeApp();
    const response = await handleDeploy(deployRequest(app, { sticky: true, dry_run: true }));
    expect(response.status).toBe(200);
    const body = await response.json() as { dry_run: boolean; changes: Array<{ field: string }> };
    expect(body.dry_run).toBe(true);
    expect(body.changes.map((change) => change.field)).toContain("sticky");
    expect(db.getApp(app.id)!.sticky).toBe(0);
  });
});
