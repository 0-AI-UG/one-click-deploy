import { test, expect, mock, beforeEach } from "bun:test";
import database, * as db from "./db.ts";
import { saveProviderConnections, saveProviderAssignments } from "./provider-connections.ts";
const realS3 = await import("../engine/object-storage/s3.ts");
mock.module("../engine/object-storage/s3.ts", () => ({ ...realS3,
  getS3Credentials: async (id: string) => ({ endpoint: `https://${id}.example.com`, region: id, accessKey: "access", secretKey: "secret" }),
  listBuckets: async () => [{ name: "shared-bucket" }],
}));
const storage = await import("./object-storage.ts");
const connections = ["first", "second"].map(id => ({ id, kind: "s3-compatible" as const, name: id, config: { endpoint: `https://${id}.example.com`, region: id }, created_at: "now" }));
beforeEach(() => {
saveProviderConnections(connections);
saveProviderAssignments({ infrastructure: "", object_storage: "first" });
database.run("PRAGMA foreign_keys=OFF");
db.insertPanel({ server_id: 1, name: "panel", domain: "panel.example.com", image_ref: `ghcr.io/test/panel@sha256:${"a".repeat(64)}`, container_port: 3001, host_port: 3001 });
database.run("PRAGMA foreign_keys=ON");
});
const input = { primary: { bucket: "shared-bucket", prefix: "app/", permissions: ["read", "write"] as Array<"read" | "write"> } };

test("default selection is pinned and existing binding survives a default change", () => {
  const first = storage.resolveStorageBindings(input);
  saveProviderAssignments({ infrastructure: "", object_storage: "second" });
  expect(storage.resolveStorageBindings(input, first).primary.connection).toBe("first");
  expect(JSON.stringify(storage.resolveStorageBindings(first, first))).toBe(JSON.stringify(first));
  expect(storage.resolveStorageBindings(input).primary.connection).toBe("second");
});
test("separate apps get separate encrypted grants; retries keep their tokens stable", async () => {
  const bindings = storage.resolveStorageBindings(input);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, bindings);
  storage.saveAppStorage(101, bindings);
  const before = await storage.appStorageEnv(101);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, bindings);
  expect(await storage.appStorageEnv(101)).toEqual(before);
  await storage.prepareStorageBindings({ id: 102, name: "two" }, bindings);
  expect((await storage.appStorageEnv(102, bindings)).OCD_STORAGE_TOKEN).not.toBe(before.OCD_STORAGE_TOKEN);
  expect(JSON.stringify(storage.getStorageGrants())).not.toContain(before.OCD_STORAGE_TOKEN);
  expect(storage.getStorageGrants().find(g => g.appId === 101)?.methods).toEqual(["GET", "HEAD", "PUT"]);
});
test("rotation retains old grant until rollout finalization; multiple bindings select separate connections", async () => {
  const previous = storage.resolveStorageBindings(input);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, previous);
  storage.saveAppStorage(101, previous);
  const next = storage.resolveStorageBindings({ ...previous, primary: { ...previous.primary, generation: 1 }, media: { connection: "first", bucket: "shared-bucket", prefix: "media/", permissions: ["read"] } }, previous);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, next);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(3);
  const vars = await storage.appStorageEnv(101, next);
  expect(vars.OCD_MEDIA_STORAGE_TOKEN).toBeTruthy();
  expect(vars.OCD_MEDIA_STORAGE_URL).toBe("https://panel.example.com/api/storage/authorize");
  storage.saveAppStorage(101, next);
  storage.retireAppStorageGrants(101);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(2);
  storage.saveAppStorage(101, {});
  storage.retireAppStorageGrants(101);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(0);
});
