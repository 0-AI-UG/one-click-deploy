import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, mock, test } from "bun:test";

mock.module("../lib/permissions.ts", () => ({
  requirePermission: async () => ({ userId: "admin", client: "cli" }),
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { getOperation } from "../../shared/db/operations.ts";
import { handleInstallGitHubRunner, handleRemoveGitHubRunner } from "./github-runners.ts";

const TOKEN = "Registration_Token_123456789012345";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runners", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GitHub runner registration route", () => {
  test("isolates an empty server and persists only an encrypted token reference", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({
      name: `runner-${suffix}`,
      provider_id: `provider-${suffix}`,
      ipv4: "203.0.113.20",
      ipv6: "",
      type: "cx32",
      location: "nbg1",
      status: "ready",
      pool: "general",
    });
    const response = await handleInstallGitHubRunner(request({
      server_id: server.id,
      scope_url: "https://github.com/0-AI-UG",
      registration_token: TOKEN,
      name: `ocd-${suffix}`,
    }));
    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(body.workflow_runs_on).toEqual(["self-hosted", "ocd-builder"]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(db.getServer(server.id)?.pool).toBe("build-runners");
    const runner = db.getGitHubRunnerByServerId(server.id)!;
    expect(runner.status).toBe("installing");
    const operation = getOperation(body.op_id)!;
    expect(operation.input_json).not.toContain(TOKEN);
    const input = JSON.parse(operation.input_json);
    expect(await secretStore.get(input.tokenSecretKey)).toBe(TOKEN);
    await secretStore.delete(input.tokenSecretKey);
  });

  test("rejects the panel host before retaining the registration token", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({
      name: `panel-${suffix}`,
      provider_id: `panel-provider-${suffix}`,
      ipv4: "203.0.113.21",
      ipv6: "",
      type: "cx32",
      location: "nbg1",
      status: "ready",
    });
    db.insertPanel({
      server_id: server.id,
      name: `panel-${suffix}`,
      domain: `${suffix}.example.com`,
      image_ref: `ghcr.io/acme/panel@sha256:${"a".repeat(64)}`,
      container_port: 3000,
      host_port: 3001,
    });
    const response = await handleInstallGitHubRunner(request({
      server_id: server.id,
      scope_url: "https://github.com/0-AI-UG",
      registration_token: TOKEN,
    }));
    expect(response.status).toBe(409);
    expect(db.getGitHubRunnerByServerId(server.id)).toBeNull();
    db.deletePanel();
  });

  test("queues one fail-closed removal without persisting its token", async () => {
    const suffix = randomSuffix();
    const server = db.insertServer({
      name: `remove-${suffix}`,
      provider_id: `remove-provider-${suffix}`,
      ipv4: "203.0.113.22",
      ipv6: "",
      type: "cx32",
      location: "nbg1",
      status: "ready",
      pool: "build-runners",
    });
    const runner = db.insertGitHubRunner({
      serverId: server.id,
      name: `ocd-remove-${suffix}`,
      scopeUrl: "https://github.com/0-AI-UG",
      previousPool: "general",
    });
    db.updateGitHubRunner(runner.id, { status: "online" });
    const removalToken = "Removal_Token_123456789012345678";
    const removalRequest = () => new Request(`http://localhost/api/runners/${runner.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ removal_token: removalToken }),
    });

    const response = await handleRemoveGitHubRunner(removalRequest(), runner.id);
    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(db.getGitHubRunner(runner.id)?.status).toBe("removing");
    const operation = getOperation(body.op_id)!;
    expect(operation.input_json).not.toContain(removalToken);
    const input = JSON.parse(operation.input_json);
    expect(await secretStore.get(input.tokenSecretKey)).toBe(removalToken);

    expect((await handleRemoveGitHubRunner(removalRequest(), runner.id)).status).toBe(409);
    await secretStore.delete(input.tokenSecretKey);
  });
});
