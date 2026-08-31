import { useTempDataDir } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import {
  enqueueOperation,
  findSupersedingOperation,
  finalizeOperation,
  getOperation,
  markOperationFinished,
  requeueOperation,
  retryOperationAsNew,
  retryWebhookOperationAsNew,
} from "./operations.ts";

describe("operation recovery persistence", () => {
  test("resumes failed compensation on the same durable operation", () => {
    const op = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: ["stack:demo"],
      input: { name: "demo" },
      trigger: "test",
    });
    markOperationFinished(op.id, "compensation_failed", { message: "cleanup failed" });

    const resumed = requeueOperation(op.id)!;
    expect(resumed.id).toBe(op.id);
    expect(resumed.status).toBe("compensating");
    expect(resumed.finished_at).toBeNull();
    expect(resumed.error_json).toBeNull();
  });

  test("a retry of a terminal operation is a fresh top-level audit row", () => {
    const parent = enqueueOperation({
      kind: "parent",
      resourceKeys: ["stack:parent"],
      input: {},
      trigger: "test",
    });
    const op = enqueueOperation({
      kind: "redeploy",
      resourceKeys: ["app:9"],
      input: { appId: 9 },
      trigger: "test",
      parentId: parent.id,
    });
    markOperationFinished(op.id, "failed", { message: "build failed" });

    const retry = retryOperationAsNew(op.id, "operator")!;
    expect(retry.id).not.toBe(op.id);
    expect(retry.parent_id).toBeNull();
    expect(retry.trigger).toBe("retry");
    expect(retry.triggered_by).toBe("operator");
    expect(JSON.parse(retry.input_json)).toEqual({ appId: 9 });
  });

  test("a webhook retry atomically transfers its failed delivery", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const server = db.insertServer({
      name: `worker-${suffix}`,
      provider_id: `provider-${suffix}`,
      ipv4: "192.0.2.20",
      ipv6: "",
      type: "cx23",
      location: "nbg1",
      status: "ready",
    });
    const worker = db.insertBuildWorker({ serverId: server.id, name: `worker-${suffix}`, previousPool: "general" });
    const source = db.upsertBuildSource({
      repository: `https://example.com/${suffix}.git`,
      branch: "main",
      workerId: worker.id,
    });
    const input = { sourceId: source.id, deliveryId: `delivery-${suffix}`, commit: "a".repeat(40) };
    db.recordBuildSourceDelivery({ sourceId: source.id, deliveryId: input.deliveryId, commitSha: input.commit });
    const original = enqueueOperation({
      kind: "webhook_build_source",
      resourceKeys: [`build-source:${source.id}`],
      input,
      trigger: "webhook",
    });
    db.attachBuildSourceDeliveryOperation({ sourceId: source.id, deliveryId: input.deliveryId, operationId: original.id });
    db.updateBuildSourceDeliveryStatus({ sourceId: source.id, deliveryId: input.deliveryId, status: "failed" });
    markOperationFinished(original.id, "compensated", { message: "build failed" });

    const retry = retryWebhookOperationAsNew(original.id, "operator", input)!;
    expect(retry.id).not.toBe(original.id);
    expect(db.getBuildSourceDelivery(source.id, input.deliveryId)).toMatchObject({
      operation_id: retry.id,
      status: "queued",
    });
  });

  test("operator finalization records an explicit terminal audit state", () => {
    const op = enqueueOperation({
      kind: "test",
      resourceKeys: ["test:1"],
      input: {},
      trigger: "test",
    });
    const finalized = finalizeOperation(op.id, "failed", "resources did not converge")!;

    expect(finalized.status).toBe("failed");
    expect(JSON.parse(finalized.error_json!)).toMatchObject({
      finalized: true,
      message: "resources did not converge",
    });
    expect(getOperation(op.id)?.finished_at).not.toBeNull();
  });

  test("ownership follows a resource from create-name key to durable numeric id", () => {
    const name = `owned-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const create = enqueueOperation({
      kind: "deploy",
      resourceKeys: [`app:create:${name}`],
      input: { app_name: name },
      trigger: "test",
    });
    const app = db.insertApp({
      name,
      domain: `${name}.example.com`,
      image_ref: `ghcr.io/acme/test@sha256:${"a".repeat(64)}`,
      container_port: 3000,
      env_vars: "{}",
    });
    const adopt = enqueueOperation({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "test",
    });

    expect(findSupersedingOperation(create)?.id).toBe(adopt.id);
  });
});
