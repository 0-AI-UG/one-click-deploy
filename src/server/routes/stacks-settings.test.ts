import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock } from "bun:test";

// Bypass auth for all tests (same pattern as staging-promote.test.ts).
mock.module("../lib/permissions.ts", () => ({
  requireAdmin: async () => ({ userId: "admin", username: "admin" }),
  requirePermission: async () => ({ userId: "admin", username: "admin" }),
}));

import * as db from "../../shared/db.ts";
import {
  handleUpdateStack,
  handleAddStackMember,
  handleRemoveStackMember,
  handleGetStack,
} from "./stacks.ts";

function makeEnv() {
  return db.insertEnvironment(`env-${randomSuffix()}`, "{}");
}

function makeStack(overrides: Partial<Parameters<typeof db.insertStack>[0]> = {}) {
  return db.insertStack({
    name: `stack-${randomSuffix()}`,
    environment_id: makeEnv().id,
    ...overrides,
  });
}

function makeApp(overrides: Partial<Parameters<typeof db.insertApp>[0]> = {}) {
  return db.insertApp({
    name: `app-${randomSuffix()}`,
    domain: "",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    ...overrides,
  });
}

function makeService() {
  return db.insertService({
    name: `svc-${randomSuffix()}`,
    service_type: "postgres",
    version: "16",
    port: 5432,
    env_vars: "{}",
    credentials: "{}",
  });
}

const patchReq = (stackId: number, body: unknown) =>
  handleUpdateStack(
    new Request(`http://x/api/stacks/${stackId}`, { method: "PATCH", body: JSON.stringify(body) }),
    stackId,
  );

const addReq = (stackId: number, body: unknown) =>
  handleAddStackMember(
    new Request(`http://x/api/stacks/${stackId}/members`, { method: "POST", body: JSON.stringify(body) }),
    stackId,
  );

const removeReq = (stackId: number, kind: string, id: number) =>
  handleRemoveStackMember(
    new Request(`http://x/api/stacks/${stackId}/members/${kind}/${id}`, { method: "DELETE" }),
    stackId,
  );

describe("PATCH /api/stacks/:id — staging environment", () => {
  test("re-points only members that already have staging on", async () => {
    const stack = makeStack();
    const oldStaging = makeEnv();
    const newStaging = makeEnv();
    const staged = makeApp({ stack_id: stack.id } as never);
    const plain = makeApp({ stack_id: stack.id } as never);
    db.setAppStack(staged.id, stack.id);
    db.setAppStack(plain.id, stack.id);
    db.updateAppWebhookStagingEnvironment(staged.id, oldStaging.id);

    const res = await patchReq(stack.id, { staging_environment_id: newStaging.id });
    expect(res.status).toBe(200);
    expect((await res.json()).members_updated).toBe(1);

    expect(db.getStack(stack.id)!.staging_environment_id).toBe(newStaging.id);
    expect(db.getApp(staged.id)!.webhook_staging_environment_id).toBe(newStaging.id);
    // A member that never opted in stays off — staging opt-in is manifest
    // intent we don't persist, so it can only be turned on by a stack deploy.
    expect(db.getApp(plain.id)!.webhook_staging_environment_id).toBeNull();
  });

  test("null clears the stack env and turns staging off on every member", async () => {
    const stack = makeStack();
    const staging = makeEnv();
    const app = makeApp();
    db.setAppStack(app.id, stack.id);
    db.updateAppWebhookStagingEnvironment(app.id, staging.id);

    const res = await patchReq(stack.id, { staging_environment_id: null });
    expect(res.status).toBe(200);
    expect(db.getStack(stack.id)!.staging_environment_id).toBeNull();
    expect(db.getApp(app.id)!.webhook_staging_environment_id).toBeNull();
  });

  test("rejects an unknown environment and the production environment", async () => {
    const stack = makeStack();
    expect((await patchReq(stack.id, { staging_environment_id: 999999 })).status).toBe(400);
    expect((await patchReq(stack.id, { staging_environment_id: stack.environment_id })).status).toBe(400);
    expect((await patchReq(stack.id, {})).status).toBe(400);
    expect((await patchReq(999999, { staging_environment_id: null })).status).toBe(404);
  });
});

describe("stack membership", () => {
  test("attaching and detaching an app only moves the stack_id", async () => {
    const stack = makeStack();
    const app = makeApp();

    expect((await addReq(stack.id, { kind: "app", id: app.id })).status).toBe(200);
    expect(db.getApp(app.id)!.stack_id).toBe(stack.id);

    const detail = await (await handleGetStack(new Request("http://x"), stack.id)).json();
    expect(detail.apps.map((a: { id: number }) => a.id)).toContain(app.id);

    expect((await removeReq(stack.id, "apps", app.id)).status).toBe(200);
    // Detach is metadata only: the app itself survives.
    expect(db.getApp(app.id)).not.toBeNull();
    expect(db.getApp(app.id)!.stack_id).toBeNull();
  });

  test("attaching a service works the same way", async () => {
    const stack = makeStack();
    const svc = makeService();

    expect((await addReq(stack.id, { kind: "service", id: svc.id })).status).toBe(200);
    expect(db.getService(svc.id)!.stack_id).toBe(stack.id);

    expect((await removeReq(stack.id, "services", svc.id)).status).toBe(200);
    expect(db.getService(svc.id)!.stack_id).toBeNull();
  });

  test("refuses to steal a member from another stack", async () => {
    const a = makeStack();
    const b = makeStack();
    const app = makeApp();
    db.setAppStack(app.id, a.id);

    const res = await addReq(b.id, { kind: "app", id: app.id });
    expect(res.status).toBe(409);
    expect(db.getApp(app.id)!.stack_id).toBe(a.id);
  });

  test("refuses to attach a staging sibling directly", async () => {
    const stack = makeStack();
    const prod = makeApp();
    const sibling = makeApp({ target_of: prod.id });

    const res = await addReq(stack.id, { kind: "app", id: sibling.id });
    expect(res.status).toBe(400);
    expect(db.getApp(sibling.id)!.stack_id).toBeNull();
  });

  test("detaching a non-member 404s", async () => {
    const stack = makeStack();
    const outsider = makeApp();
    expect((await removeReq(stack.id, "apps", outsider.id)).status).toBe(404);
    expect((await addReq(stack.id, { kind: "nope", id: 1 })).status).toBe(400);
  });
});
