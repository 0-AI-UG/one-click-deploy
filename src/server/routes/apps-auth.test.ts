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
import { getOperation } from "../../shared/db/operations.ts";
import { handleDeploy, handleGetApps, handleGetDashboard, handleReleaseApp } from "./apps.ts";

const DIGEST_A = `ghcr.io/acme/app@sha256:${"a".repeat(64)}`;
const DIGEST_B = `ghcr.io/acme/app@sha256:${"b".repeat(64)}`;

function makeApp(overrides: Partial<Parameters<typeof db.insertApp>[0]> = {}) {
  return db.insertApp({
    name: `app-${Math.random().toString(36).slice(2, 8)}`,
    domain: "gated.example.com",
    container_port: 3000,
    env_vars: "{}",
    image_ref: DIGEST_A,
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
      image_ref: app.image_ref,
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
    db.updateAppSleepingState(app.id, 1, 10001);

    const response = await handleGetApps(new Request("http://x/api/apps"));
    const row = ((await response.json()) as Array<Record<string, unknown>>).find((candidate) => candidate.id === app.id)!;
    expect(row).not.toHaveProperty("auth_password");
    expect(row).not.toHaveProperty("auth_password_hash");
    expect(row).not.toHaveProperty("wake_token");
    expect(row.env_vars).toEqual([]);
    expect(row.auth_enabled).toBe(true);
  });

  test("compact dashboard omits large and sensitive fields needed only by the web UI", async () => {
    const app = makeApp({
      domain: "compact.example.com",
      public: true,
      internal_protocol: "http",
    });
    db.appendDeployLog(app.id, "x".repeat(256_000));
    const service = db.insertService({
      name: `service-${Math.random().toString(36).slice(2, 8)}`,
      service_type: "postgres",
      version: "16",
      port: 5432,
      env_vars: '{"VISIBLE":"no"}',
      credentials: '{"PASSWORD":"secret"}',
    });

    const response = await handleGetDashboard(new Request("http://x/api/dashboard?compact=1"));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      apps: Array<Record<string, unknown>>;
      services: Array<Record<string, unknown>>;
    };
    const appRow = body.apps.find((row) => row.id === app.id)!;
    const serviceRow = body.services.find((row) => row.id === service.id)!;

    expect(Object.keys(appRow).sort()).toEqual([
      "container_port",
      "deployed_commit",
      "dns_instruction",
      "domain",
      "environment_stale",
      "id",
      "internal_protocol",
      "name",
      "public",
      "status",
    ]);
    expect(Object.keys(serviceRow).sort()).toEqual(["id", "name", "service_type", "status"]);
    expect(raw).not.toContain("x".repeat(1_000));
    expect(raw).not.toContain("secret");
    expect(raw.length).toBeLessThan(10_000);

    const fullResponse = await handleGetDashboard(new Request("http://x/api/dashboard"));
    const fullBody = await fullResponse.json() as {
      apps: Array<Record<string, unknown>>;
      services: Array<Record<string, unknown>>;
    };
    expect(fullBody.apps.find((row) => row.id === app.id)?.deploy_log).toContain("x".repeat(1_000));
    expect(fullBody.services.find((row) => row.id === service.id)?.credentials).toContain("secret");
  });
});

describe("external artifact release endpoint", () => {
  test("enqueues an atomic immutable-image candidate and preserves configuration", async () => {
    const app = makeApp({ sticky: true, placement_pool: "workers" });
    db.updateAppMemory(app.id, 768);
    const request = new Request(`http://x/api/apps/${app.id}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "github-42-1" },
      body: JSON.stringify({ image: DIGEST_B, commit: "c".repeat(40) }),
    });
    const response = await handleReleaseApp(request, app.id);
    expect(response.status).toBe(200);
    const body = await response.json() as { op_id: number; image: string };
    expect(body.image).toBe(DIGEST_B);
    const operation = getOperation(body.op_id)!;
    const input = JSON.parse(operation.input_json) as {
      gitCommit: string;
      candidate: { image_ref: string; sticky: boolean; memory_mb: number; placement_pool: string };
    };
    expect(input.gitCommit).toBe("c".repeat(40));
    expect(input.candidate).toMatchObject({
      image_ref: DIGEST_B,
      sticky: true,
      memory_mb: 768,
      placement_pool: "workers",
    });
    expect(operation.idempotency_key).toBe(`release:${app.id}:github-42-1`);
    expect(db.getApp(app.id)!.image_ref).toBe(DIGEST_A);
  });

  test("preserves legacy attached-volume intent during an image-only release", async () => {
    const app = makeApp();
    db.updateAppDesiredVolume(app.id, {
      volumeId: "legacy-volume-42",
      sizeGb: -1,
      mountPath: "/data",
    });
    const response = await handleReleaseApp(new Request(`http://x/api/apps/${app.id}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: DIGEST_B, commit: "d".repeat(40) }),
    }), app.id);

    expect(response.status).toBe(200);
    const body = await response.json() as { op_id: number };
    const operation = getOperation(body.op_id)!;
    const input = JSON.parse(operation.input_json) as {
      candidate: { volume_id: string; volume_size: number; volume_path: string };
    };
    expect(input.candidate).toMatchObject({
      volume_id: "legacy-volume-42",
      volume_size: -1,
      volume_path: "/data",
    });
  });

  test("rejects tags and malformed replay keys before enqueue", async () => {
    const app = makeApp();
    const tagged = await handleReleaseApp(new Request(`http://x/api/apps/${app.id}/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "ghcr.io/acme/app:latest" }),
    }), app.id);
    expect(tagged.status).toBe(400);

    const badKey = await handleReleaseApp(new Request(`http://x/api/apps/${app.id}/release`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "contains spaces" },
      body: JSON.stringify({ image: DIGEST_B }),
    }), app.id);
    expect(badKey.status).toBe(400);
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
