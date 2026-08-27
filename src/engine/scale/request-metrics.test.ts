// Unit tests for request-metrics: Prometheus counter parsing, per-server
// delta/reset semantics, last_request_at persistence, and the scrape
// freshness gate the idle monitor's fail-safe relies on.
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeEach } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  parseServiceRequestTotals,
  ingestServerRequestMetrics,
  requestMetricsFresh,
  resetRequestMetricsState,
  METRICS_FRESH_MS,
} from "./request-metrics.ts";

function makeServer() {
  return db.insertServer({
    name: `srv-rm-${randomSuffix()}`,
    provider_id: `h-rm-${randomSuffix()}`,
    ipv4: "203.0.113.20",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function makeApp() {
  return db.insertApp({
    name: `rm-app-${randomSuffix()}`,
    domain: "",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    public: false,
  });
}

/** Make `serverId` the panel — freshness now tracks the panel's scrape. */
function makePanel(serverId: number) {
  return db.insertPanel({
    server_id: serverId,
    name: "ocd-panel",
    domain: "panel.example.com",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3001,
    host_port: 3001,
  });
}

function metricsFor(appName: string, entries: Array<{ code: string; n: number }>): string {
  const lines = [
    "# HELP traefik_service_requests_total How many HTTP requests processed on a service.",
    "# TYPE traefik_service_requests_total counter",
  ];
  for (const e of entries) {
    lines.push(
      `traefik_service_requests_total{code="${e.code}",method="GET",protocol="http",service="app-${appName}@file"} ${e.n}`,
    );
  }
  return lines.join("\n") + "\n";
}

beforeEach(() => {
  resetRequestMetricsState();
  db.deletePanel(); // freshness reads db.getPanel() — keep tests independent
});

describe("parseServiceRequestTotals", () => {
  test("sums across code/method label sets and strips the @file suffix", () => {
    const text = [
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="app-foo@file"} 10`,
      `traefik_service_requests_total{code="404",method="POST",protocol="http",service="app-foo@file"} 2.5`,
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="svc-n8n@file"} 7`,
    ].join("\n");
    const totals = parseServiceRequestTotals(text);
    expect(totals.get("app-foo")).toBe(12.5);
    expect(totals.get("svc-n8n")).toBe(7);
  });

  test("ignores comments, other metrics, and similarly-prefixed counters", () => {
    const text = [
      "# HELP traefik_service_requests_total ...",
      `traefik_service_requests_tls_total{service="app-foo@file",tls_cipher="x",tls_version="1.3"} 99`,
      `traefik_entrypoint_requests_total{code="200",entrypoint="web",method="GET",protocol="http"} 50`,
      `traefik_service_request_duration_seconds_sum{code="200",method="GET",protocol="http",service="app-foo@file"} 1.2`,
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="app-foo@file"} 3`,
    ].join("\n");
    const totals = parseServiceRequestTotals(text);
    expect(totals.size).toBe(1);
    expect(totals.get("app-foo")).toBe(3);
  });

  test("skips malformed lines and non-numeric values", () => {
    const text = [
      `traefik_service_requests_total{code="200" no-closing-brace`,
      `traefik_service_requests_total{code="200",method="GET"} 5`,
      `traefik_service_requests_total{service="app-foo@file"} not-a-number`,
    ].join("\n");
    expect(parseServiceRequestTotals(text).size).toBe(0);
  });
});

describe("ingestServerRequestMetrics", () => {
  test("first scrape is baseline only: no last_request_at, but panel becomes fresh", () => {
    const server = makeServer();
    makePanel(server.id);
    const app = makeApp();
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 1000 }]));

    expect(db.getApp(app.id)!.last_request_at).toBeNull();
    expect(requestMetricsFresh()).toBe(true);
  });

  test("counter increase sets last_request_at and requests_per_min", () => {
    const server = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 100 }]), t0);
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 130 }]), t0 + 30_000);

    const after = db.getApp(app.id)!;
    expect(after.last_request_at).toBe(new Date(t0 + 30_000).toISOString());
    expect(after.requests_per_min).toBe(30);
  });

  test("zero delta leaves last_request_at untouched and decays the rate", () => {
    const server = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 100 }]), t0);
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 130 }]), t0 + 30_000);
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 130 }]), t0 + 120_000);

    const after = db.getApp(app.id)!;
    expect(after.last_request_at).toBe(new Date(t0 + 30_000).toISOString());
    expect(after.requests_per_min).toBe(0);
  });

  test("counter reset (Traefik restart): new value is the delta, not a negative", () => {
    const server = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 500 }]), t0);
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 4 }]), t0 + 30_000);

    const after = db.getApp(app.id)!;
    expect(after.last_request_at).toBe(new Date(t0 + 30_000).toISOString());
    expect(after.requests_per_min).toBe(4);
  });

  test("series appearing mid-run counts fully as new activity", () => {
    const server = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    // Baseline has no series for this app (no requests since Traefik start).
    ingestServerRequestMetrics(server.id, "# empty but successful scrape\n", t0);
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 6 }]), t0 + 30_000);

    expect(db.getApp(app.id)!.last_request_at).toBe(new Date(t0 + 30_000).toISOString());
  });

  test("deltas from two servers aggregate into one app rate", () => {
    const s1 = makeServer();
    const s2 = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    ingestServerRequestMetrics(s1.id, metricsFor(app.name, [{ code: "200", n: 10 }]), t0);
    ingestServerRequestMetrics(s2.id, metricsFor(app.name, [{ code: "200", n: 20 }]), t0);
    ingestServerRequestMetrics(s1.id, metricsFor(app.name, [{ code: "200", n: 15 }]), t0 + 30_000);
    ingestServerRequestMetrics(s2.id, metricsFor(app.name, [{ code: "200", n: 27 }]), t0 + 30_000);

    expect(db.getApp(app.id)!.requests_per_min).toBe(12);
  });

  test("failed scrape (null/empty) does not mark the panel fresh", () => {
    const server = makeServer();
    makePanel(server.id);
    ingestServerRequestMetrics(server.id, null);
    expect(requestMetricsFresh()).toBe(false);
    ingestServerRequestMetrics(server.id, "   \n");
    expect(requestMetricsFresh()).toBe(false);
  });

  test("only app-* Traefik service counters feed last_request_at (svc-* ignored)", () => {
    const server = makeServer();
    const app = makeApp();
    const t0 = Date.now();
    // Same counter name/values but under the svc- prefix (a catalog service,
    // not an app router) — must never count as app activity.
    const svcLine = (n: number) =>
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="svc-${app.name}@file"} ${n}\n`;
    ingestServerRequestMetrics(server.id, svcLine(10), t0);
    ingestServerRequestMetrics(server.id, svcLine(50), t0 + 30_000);

    const after = db.getApp(app.id)!;
    expect(after.last_request_at).toBeNull();
    expect(after.requests_per_min).toBe(0);
  });

  test("unknown service names are ignored", () => {
    const server = makeServer();
    makePanel(server.id);
    ingestServerRequestMetrics(server.id, metricsFor("no-such-app", [{ code: "200", n: 1 }]));
    ingestServerRequestMetrics(server.id, metricsFor("no-such-app", [{ code: "200", n: 5 }]));
    // No throw, panel still fresh.
    expect(requestMetricsFresh()).toBe(true);
  });
});

describe("requestMetricsFresh (panel-based)", () => {
  test("false when there is no panel, even after a successful scrape", () => {
    const server = makeServer();
    ingestServerRequestMetrics(server.id, "# ok\n");
    expect(requestMetricsFresh()).toBe(false);
  });

  test("false before scrape, true within the window, false beyond it", () => {
    const server = makeServer();
    makePanel(server.id);
    expect(requestMetricsFresh()).toBe(false);

    const t0 = Date.now();
    ingestServerRequestMetrics(server.id, "# ok\n", t0);
    expect(requestMetricsFresh(t0 + 1000)).toBe(true);
    expect(requestMetricsFresh(t0 + METRICS_FRESH_MS + 1)).toBe(false);
  });

  test("tracks the panel's scrape, not a non-panel server's", () => {
    const panelSrv = makeServer();
    const worker = makeServer();
    makePanel(panelSrv.id);

    // Only a worker was scraped → panel is still stale.
    ingestServerRequestMetrics(worker.id, "# ok\n");
    expect(requestMetricsFresh()).toBe(false);

    // The panel's own scrape is what flips it fresh.
    ingestServerRequestMetrics(panelSrv.id, "# ok\n");
    expect(requestMetricsFresh()).toBe(true);
  });
});
