import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";
mock.module("../lib/permissions.ts", () => ({
  requireAdmin: async () => ({ userId: "admin", client: "cli" }),
  requirePermission: async () => ({ userId: "admin", client: "cli" }),
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  handleDeleteRegistryConnection,
  handleDeleteSourceConnection,
  handleGetConnections,
  handlePutRegistryConnection,
  handlePutSourceConnection,
} from "./readiness.ts";

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  db.saveSetting("oci_artifact_ref", "");
  db.saveSetting("oci_registry_username", "");
  db.saveSetting("github_build_host", "");
  db.saveSetting("github_build_username", "");
  await secretStore.delete("oci_registry_password");
  await secretStore.delete("github_build_token");
});

describe("build connections", () => {
  test("stores registry credentials encrypted and returns only a mask", async () => {
    const response = await handlePutRegistryConnection(request("/api/admin/connections/registry", "PUT", {
      scope: "https://registry.example.com/Team/",
      username: "registry-user",
      token: "registry-secret",
    }));
    expect(response.status).toBe(200);
    expect(db.getSettings().oci_artifact_ref).toBe("registry.example.com/team");
    expect(await secretStore.get("oci_registry_password")).toBe("registry-secret");

    const status = await handleGetConnections(request("/api/admin/connections", "GET"));
    const body = await status.json() as any;
    expect(body.registry.connected).toBe(true);
    expect(body.registry.token).not.toContain("registry-secret");
  });

  test("rejects a tagged value as a credential namespace", async () => {
    const response = await handlePutRegistryConnection(request("/api/admin/connections/registry", "PUT", {
      scope: "registry.example.com/team/app:latest",
      username: "acme",
      token: "secret",
    }));
    expect(response.status).toBe(400);
  });

  test("disconnect clears the registry secret and metadata", async () => {
    db.saveSetting("oci_artifact_ref", "registry.example.com/team");
    db.saveSetting("oci_registry_username", "registry-user");
    await secretStore.set("oci_registry_password", "secret");
    expect((await handleDeleteRegistryConnection(request("/api/admin/connections/registry", "DELETE"))).status).toBe(200);
    expect(await secretStore.get("oci_registry_password")).toBeNull();
    expect(db.getSettings().oci_artifact_ref).toBe("");
  });

  test("stores a host-scoped private-source connection", async () => {
    const response = await handlePutSourceConnection(request("/api/admin/connections/source", "PUT", {
      host: "GitLab.example.com",
      username: "git-user",
      token: "source-secret",
    }));
    expect(response.status).toBe(200);
    expect(db.getSettings().github_build_host).toBe("gitlab.example.com");
    expect(await secretStore.get("github_build_token")).toBe("source-secret");
  });

  test("disconnect returns private-source metadata to provider-neutral defaults", async () => {
    db.saveSetting("github_build_host", "github.com");
    db.saveSetting("github_build_username", "x-access-token");
    await secretStore.set("github_build_token", "source-secret");

    expect((await handleDeleteSourceConnection(request("/api/admin/connections/source", "DELETE"))).status).toBe(200);
    expect(await secretStore.get("github_build_token")).toBeNull();
    expect(db.getSettings().github_build_host).toBe("");
    expect(db.getSettings().github_build_username).toBe("");
    const body = await (await handleGetConnections(request("/api/admin/connections", "GET"))).json() as any;
    expect(body.source).toMatchObject({ connected: false, host: "", username: "" });
  });
});
