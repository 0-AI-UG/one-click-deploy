import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();
import { expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import { appStorageMounts, localStorageInventory } from "./storage-inventory.ts";
import { localVolumeIdentity, storageUsage } from "../../shared/storage-display.ts";

test("local storage retains its host identity after app deletion and has no advertised capacity", () => {
  const server = db.insertServer({ name: "storage-host", provider_id: "storage-test", ipv4: "127.0.0.1", ipv6: "", type: "test", location: "nbg1", status: "ready" });
  const id = `local:${server.id}:retained-db`;
  db.retireVolume({ providerVolumeId: id, formerResourceType: "app", formerResourceId: 991, formerResourceName: "old-db", reason: "test", driverId: "local-directory" });
  db.retireVolume({ providerVolumeId: "123456", formerResourceType: "app", formerResourceId: 992, formerResourceName: "provider-db", reason: "test", driverId: "hetzner" });
  const entries = localStorageInventory();
  const local = entries.find(m => m.id === id)!;
  expect(local.server_id).toBe(server.id);
  expect(local.host_path).toBe("/var/lib/ocd/volumes/retained-db");
  expect(local.state).toBe("retained");
  expect(local.used_bytes).toBeNull();
  expect(local).not.toHaveProperty("size");
  expect(entries.some(m => m.id === "123456")).toBe(false);
});

test("app storage exposes local primary and extra mounts without a fictional quota", () => {
  const app = db.insertApp({ name: "storage-app", domain: "", image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", container_port: 5432, env_vars: "{}" });
  const mounts = appStorageMounts({ ...app, volume_id: "local:7:shared-db", volume_driver: "local-directory", volume_mount: "/wrong:/var/lib/postgresql/data", desired_volume_size: 10, extra_volumes: '["/srv/media:/media"]' });
  expect(mounts[0]!.host_path).toBe("/var/lib/ocd/volumes/shared-db");
  expect(mounts[0]!.container_path).toBe("/var/lib/postgresql/data");
  expect(mounts[0]!.kind).toBe("local-directory");
  expect(mounts[1]!.host_path).toBe("/srv/media");
  expect(mounts[0]).not.toHaveProperty("size");
  expect(appStorageMounts({ ...app, volume_id: "123456", volume_driver: "hetzner", volume_mount: "/mnt/data:/data" })[0]!.kind).toBe("provider-volume");
});

test("invalid local IDs cannot become host paths and missing usage is not zero", () => {
  expect(localVolumeIdentity("local:7:../../etc")).toBeNull();
  expect(localVolumeIdentity("123456")).toBeNull();
  expect(storageUsage(null)).toBe("Usage unavailable");
  expect(storageUsage(0)).toBe("0.00 GiB used");
});
