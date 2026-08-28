import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, mock, test } from "bun:test";
mock.module("../lib/permissions.ts", () => ({ requirePermission: async () => ({ userId: "admin", client: "cli" }) }));

import * as db from "../../shared/db.ts";
import { getOperation } from "../../shared/db/operations.ts";
import { handleInstallBuildWorker, handleRemoveBuildWorker } from "./build-workers.ts";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runners", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("OCD build worker route", () => {
  test("isolates an empty server without GitHub credentials", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({ name: `worker-${suffix}`, provider_id: `provider-${suffix}`, ipv4: "203.0.113.20", ipv6: "", type: "cx23", location: "nbg1", status: "ready", pool: "general" });
    const response = await handleInstallBuildWorker(request({ server_id: server.id, name: `ocd-${suffix}` }));
    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(db.getServer(server.id)?.pool).toBe("build-workers");
    const worker = db.getBuildWorkerByServerId(server.id)!;
    expect(worker.status).toBe("installing");
    expect(getOperation(body.op_id)?.input_json).not.toContain("token");
  });

  test("rejects the panel host", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({ name: `panel-${suffix}`, provider_id: `panel-provider-${suffix}`, ipv4: "203.0.113.21", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
    db.insertPanel({ server_id: server.id, name: `panel-${suffix}`, domain: `${suffix}.example.com`, image_ref: `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`, container_port: 3000, host_port: 3001 });
    expect((await handleInstallBuildWorker(request({ server_id: server.id }))).status).toBe(409);
    expect(db.getBuildWorkerByServerId(server.id)).toBeNull();
    db.deletePanel();
  });

  test("queues removal while retaining the server", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({ name: `remove-${suffix}`, provider_id: `remove-provider-${suffix}`, ipv4: "203.0.113.22", ipv6: "", type: "cx23", location: "nbg1", status: "ready", pool: "build-workers" });
    const worker = db.insertBuildWorker({ serverId: server.id, name: `ocd-remove-${suffix}`, previousPool: "general" });
    const response = await handleRemoveBuildWorker(new Request(`http://localhost/api/runners/${worker.id}`, { method: "DELETE" }), worker.id);
    expect(response.status).toBe(202);
    expect(getOperation((await response.json() as any).op_id)?.kind).toBe("remove_build_worker");
  });
});
