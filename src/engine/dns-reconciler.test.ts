import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

let answers: string[] = [];

mock.module("node:dns/promises", () => ({
  resolve4: mock(async () => answers),
}));

import * as db from "../shared/db.ts";
const { reconcileAppDns, reconcilePanelDns, reconcileServiceDns } = await import("./dns-reconciler.ts");
const observerSource = readFileSync(new URL("./dns-reconciler.ts", import.meta.url), "utf8");

function makeApp(domain: string, isPublic = true) {
  return db.insertApp({
    name: `dns-${randomSuffix()}`,
    domain,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    public: isPublic,
  });
}

beforeEach(() => {
  answers = [];
  db.deletePanel();
  const server = db.insertServer({
    name: `dns-panel-${randomSuffix()}`,
    provider_id: `dns-panel-provider-${randomSuffix()}`,
    ipv4: "203.0.113.10",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  db.insertPanel({
    server_id: server.id,
    name: "ocd-panel",
    domain: "panel.example.com",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    host_port: 3001,
  });
});

function expectNoProviderMutation() {
  expect(observerSource).not.toContain("providers/");
  expect(observerSource).not.toContain("createRecord");
  expect(observerSource).not.toContain("deleteRecord");
}

describe("provider-neutral DNS instructions", () => {
  test("reports a copyable pending instruction without writing DNS", async () => {
    const result = await reconcileAppDns(makeApp("docs.example.com").id);
    expect(result).toMatchObject({
      status: "pending",
      record: { type: "A", name: "docs.example.com", value: "203.0.113.10" },
      observedValues: [],
      ready: false,
    });
    expectNoProviderMutation();
  });

  test("reports correct only when the observed RRSet is the exact target", async () => {
    answers = ["203.0.113.10"];
    const app = makeApp("ready.example.com");
    const result = await reconcileAppDns(app.id);
    expect(result.status).toBe("correct");
    expect(result.ready).toBe(true);
    expect(db.getApp(app.id)?.public_endpoint_status).toBe("ready");
    expectNoProviderMutation();
  });

  test("reports conflicting values and does not replace them", async () => {
    answers = ["198.51.100.8", "203.0.113.10"];
    const result = await reconcileAppDns(makeApp("conflict.example.com").id);
    expect(result.status).toBe("conflicting");
    expect(result.observedValues).toEqual(["198.51.100.8", "203.0.113.10"]);
    expectNoProviderMutation();
  });

  test("private apps have no instruction", async () => {
    const result = await reconcileAppDns(makeApp("private.example.com", false).id);
    expect(result.status).toBe("not_applicable");
    expect(result.record).toBeNull();
    expectNoProviderMutation();
  });

  test("nip.io fallback domains have no manual instruction", async () => {
    const result = await reconcileAppDns(makeApp("app.203.0.113.10.nip.io").id);
    expect(result.status).toBe("not_applicable");
    expect(result.record).toBeNull();
    expectNoProviderMutation();
  });

  test("deletion intent leaves DNS untouched and gives manual cleanup guidance", async () => {
    const app = makeApp("delete.example.com");
    db.markAppDeletionRequested(app.id);
    const result = await reconcileAppDns(app.id);
    expect(result.status).toBe("not_applicable");
    expect(result.message).toMatch(/delete.*manually/i);
    expectNoProviderMutation();
  });

  test("reports the panel record against its server IP", async () => {
    const server = db.insertServer({
      name: `panel-${randomSuffix()}`,
      provider_id: `provider-${randomSuffix()}`,
      ipv4: "203.0.113.20",
      ipv6: "",
      type: "cx23",
      location: "nbg1",
      status: "ready",
    });
    db.deletePanel();
    db.insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      host_port: 3001,
    });

    const result = await reconcilePanelDns();
    expect(result.record).toEqual({ type: "A", name: "panel.example.com", value: "203.0.113.20" });
    expectNoProviderMutation();
    db.deletePanel();
  });

  test("HTTP services receive instructions while raw services do not", async () => {
    const http = db.insertService({
      name: `flowise-${randomSuffix()}`,
      service_type: "flowise",
      version: "latest",
      port: 3000,
      env_vars: "{}",
      credentials: JSON.stringify({ domain: "flow.example.com" }),
    });
    const raw = db.insertService({
      name: `postgres-${randomSuffix()}`,
      service_type: "postgresql",
      version: "16",
      port: 5432,
      env_vars: "{}",
      credentials: JSON.stringify({ domain: "db.example.com" }),
    });
    expect((await reconcileServiceDns(http.id)).record?.name).toBe("flow.example.com");
    expect((await reconcileServiceDns(raw.id)).status).toBe("not_applicable");
    expectNoProviderMutation();
  });
});
