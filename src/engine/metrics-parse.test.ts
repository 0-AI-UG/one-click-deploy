// Tests for collectServerMetrics' panel-only Traefik scrape gating. Parsing of
// the individual sections is covered by the pure-function tests; here we only
// verify that the Traefik curl is included (and its output surfaced) for the
// panel, and omitted (traefikMetrics=null) for workers.
import { describe, test, expect, mock, beforeEach } from "bun:test";

let lastCmd = "";
const sshExec = mock(async (_host: string, cmd: string, _hostKey?: string) => {
  lastCmd = cmd;
  // A full batched-metrics stdout with a populated Traefik section.
  const stdout = [
    "{}", // docker stats (empty)
    "---LIMITS---",
    "",
    "---SEPARATOR---",
    "%Cpu(s):  1.0 us,  0.0 sy,  0.0 ni, 99.0 id",
    "MemTotal:       1000 kB",
    "MemAvailable:    500 kB",
    "DISK 100 1000",
    "---TRAEFIK-METRICS---",
    'traefik_service_requests_total{service="app-foo@file"} 5',
  ].join("\n");
  return { exitCode: 0, stdout, stderr: "" };
});
mock.module("../shared/remote/index.ts", () => ({ sshExec }));

import { collectServerMetrics } from "./metrics-parse.ts";
import { TRAEFIK_METRICS_PORT } from "./scale/traefik-constants.ts";

const server = { ipv4: "203.0.113.99", ssh_host_key: "" } as any;

beforeEach(() => {
  sshExec.mockClear();
  lastCmd = "";
});

describe("collectServerMetrics Traefik scrape gating", () => {
  test("panel (scrapeTraefik) curls :metrics and surfaces the counters", async () => {
    const res = await collectServerMetrics(server, { scrapeTraefik: true });
    expect(lastCmd).toContain(`${TRAEFIK_METRICS_PORT}/metrics`);
    expect(lastCmd).toContain("curl");
    expect(res.traefikMetrics).toContain("traefik_service_requests_total");
  });

  test("worker (default) omits the curl and returns null metrics", async () => {
    const res = await collectServerMetrics(server);
    expect(lastCmd).not.toContain("curl");
    expect(lastCmd).not.toContain(`${TRAEFIK_METRICS_PORT}/metrics`);
    // Even though the mock emits a Traefik section, a non-panel scrape never
    // surfaces it.
    expect(res.traefikMetrics).toBeNull();
    // Server-level metrics are still parsed on workers.
    expect(res.serverMetrics).not.toBeNull();
  });
});
