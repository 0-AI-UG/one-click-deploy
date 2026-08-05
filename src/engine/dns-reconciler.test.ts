import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, mock, test } from "bun:test";

const createRecord = mock(async (opts: { name: string; type: string; value: string }) => ({
  id: `${opts.name}/${opts.type}/${opts.value}`,
  ...opts,
}));
const deleteRecord = mock(async () => {});
let answers: string[] = [];

mock.module("../shared/providers/index.ts", () => ({
  hetznerDns: { createRecord, deleteRecord },
}));
mock.module("./scale/traefik-manager.ts", () => ({
  getPanelIngressIpv4: () => "203.0.113.10",
}));
mock.module("node:dns/promises", () => ({
  resolve4: mock(async () => answers),
}));

import * as db from "../shared/db.ts";
const { reconcileAppDns } = await import("./dns-reconciler.ts");

function makeApp(domain: string) {
  return db.insertApp({
    name: `dns-${randomSuffix()}`,
    domain,
    git_repo: "https://github.com/example/app",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    public: true,
  });
}

beforeEach(() => {
  answers = [];
  createRecord.mockClear();
  createRecord.mockImplementation(async (opts: { name: string; type: string; value: string }) => ({
    id: `${opts.name}/${opts.type}/${opts.value}`,
    ...opts,
  }));
  deleteRecord.mockClear();
  db.saveSetting("dns_zone_id", "zone-1");
  db.saveSetting("dns_zone_name", "example.com");
});

describe("DNS desired-state reconciliation", () => {
  test("creates and tracks a missing record for an existing app", async () => {
    const app = makeApp("docs.example.com");
    const result = await reconcileAppDns(app.id);

    expect(result.managed).toBe(true);
    expect(result.ready).toBe(false);
    expect(createRecord).toHaveBeenCalledWith({
      zoneId: "zone-1",
      name: "docs",
      type: "A",
      value: "203.0.113.10",
    });
    expect(db.getDnsRecords(app.id)).toHaveLength(1);
    expect(db.getApp(app.id)?.public_endpoint_status).toBe("degraded");
  });

  test("repairs a provider record that disappeared after deployment", async () => {
    const app = makeApp("repair.example.com");
    db.insertDnsRecord({
      app_id: app.id,
      zone_id: "zone-1",
      record_id: "repair/A/203.0.113.10",
      name: "repair",
      type: "A",
      value: "203.0.113.10",
    });

    await reconcileAppDns(app.id);
    expect(createRecord).toHaveBeenCalledTimes(1);
  });

  test("never writes an explicit domain outside the configured zone", async () => {
    const app = makeApp("docs.other.example");
    const result = await reconcileAppDns(app.id);

    expect(result.managed).toBe(false);
    expect(createRecord).not.toHaveBeenCalled();
    expect(result.error).toMatch(/unmanaged domain/i);
  });

  test("persists and surfaces provider failures", async () => {
    const app = makeApp("broken.example.com");
    createRecord.mockImplementationOnce(async () => { throw new Error("provider unavailable"); });

    await expect(reconcileAppDns(app.id)).rejects.toThrow(/provider unavailable/i);
    expect(db.getApp(app.id)?.public_endpoint_status).toBe("degraded");
    expect(db.getApp(app.id)?.public_endpoint_error).toMatch(/provider unavailable/i);
  });
});
