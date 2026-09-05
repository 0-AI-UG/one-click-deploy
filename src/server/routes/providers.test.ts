import { seedTestAdmin, useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realPermissions = await import("../lib/permissions.ts");
mock.module("../lib/permissions.ts", () => ({
  ...realPermissions,
  requireAdmin: async () => ({ userId: seedTestAdmin(), username: "admin" }),
}));

const realS3 = await import("../../engine/object-storage/s3.ts");
const listBucketsMock = mock(async () => []);
mock.module("../../engine/object-storage/s3.ts", () => ({ ...realS3, listBuckets: listBucketsMock }));

import db, * as database from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { makeFakeComputeProvider } from "../../shared/test-helpers.ts";
import { __replaceInfrastructureProvidersForTest } from "../../shared/providers/registry.ts";
import { getProviderAssignments, getProviderConnections, providerSecretKey } from "../../shared/provider-connections.ts";
import {
  handleCreateProvider,
  handleDeleteProvider,
  handleGetProviders,
  handleSaveProviderAssignments,
  handleUpdateProvider,
} from "./providers.ts";

const compute = makeFakeComputeProvider();

function req(body?: unknown): Request {
  return new Request("http://localhost/api/admin/providers", {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  __replaceInfrastructureProvidersForTest([compute]);
  db.query("DELETE FROM encrypted_secrets").run();
  database.saveSetting("provider_connections", "[]");
  database.saveSetting("provider_assignments", JSON.stringify({ infrastructure: "", object_storage: "" }));
  listBucketsMock.mockClear();
});

describe("admin provider connections", () => {
  test("creates, verifies, masks, and automatically assigns a Hetzner connection", async () => {
    const response = await handleCreateProvider(req({
      kind: "hetzner",
      name: "Production cloud",
      credentials: { api_token: "x".repeat(40) },
    }));
    expect(response.status).toBe(201);
    const connection = getProviderConnections()[0];
    expect(getProviderAssignments()).toEqual({
      infrastructure: connection.id,
      object_storage: "",
    });
    expect(await secretStore.get(providerSecretKey(connection.id, "api_token"))).toBe("x".repeat(40));

    const shown = await (await handleGetProviders(req())).json() as any;
    expect(shown.providers[0].credentials.api_token).toContain("...");
    expect(shown.providers[0].credentials.api_token).not.toBe("x".repeat(40));
  });

  test("creates a generic S3-compatible connection with all settings in one profile", async () => {
    const response = await handleCreateProvider(req({
      kind: "s3-compatible",
      name: "Hetzner Object Storage",
      config: { endpoint: "https://fsn1.your-objectstorage.com/", region: "fsn1" },
      credentials: { access_key: "access-123456", secret_key: "secret-123456" },
    }));
    expect(response.status).toBe(201);
    expect(listBucketsMock).toHaveBeenCalledTimes(1);
    const connection = getProviderConnections()[0];
    expect(connection).toMatchObject({
      kind: "s3-compatible",
      name: "Hetzner Object Storage",
      config: { endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1" },
    });
    expect(getProviderAssignments().object_storage).toBe(connection.id);
  });

  test("preserves encrypted credentials when editing with blank secret fields", async () => {
    await handleCreateProvider(req({ kind: "hetzner", name: "Cloud", credentials: { api_token: "a".repeat(40) } }));
    const connection = getProviderConnections()[0];
    const response = await handleUpdateProvider(req({ name: "Renamed cloud", credentials: { api_token: "" } }), connection.id);
    expect(response.status).toBe(200);
    expect(getProviderConnections()[0].name).toBe("Renamed cloud");
    expect(await secretStore.get(providerSecretKey(connection.id, "api_token"))).toBe("a".repeat(40));
  });

  test("requires unassignment before deleting a connection and then removes its secret", async () => {
    await handleCreateProvider(req({ kind: "hetzner", name: "Cloud", credentials: { api_token: "b".repeat(40) } }));
    const connection = getProviderConnections()[0];
    expect((await handleDeleteProvider(req(), connection.id)).status).toBe(409);
    expect((await handleSaveProviderAssignments(req({ infrastructure: "", object_storage: "" }))).status).toBe(200);
    expect((await handleDeleteProvider(req(), connection.id)).status).toBe(200);
    expect(getProviderConnections()).toHaveLength(0);
    expect(await secretStore.get(providerSecretKey(connection.id, "api_token"))).toBeNull();
  });
});
