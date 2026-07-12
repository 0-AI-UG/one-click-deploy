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
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    public: false,
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
  test("first scrape is baseline only: no last_request_at, but server becomes fresh", () => {
    const server = makeServer();
    const app = makeApp();
    ingestServerRequestMetrics(server.id, metricsFor(app.name, [{ code: "200", n: 1000 }]));

    expect(db.getApp(app.id)!.last_request_at).toBeNull();
    expect(requestMetricsFresh([server.id])).toBe(true);
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

  test("failed scrape (null/empty) does not mark the server fresh", () => {
    const server = makeServer();
    ingestServerRequestMetrics(server.id, null);
    expect(requestMetricsFresh([server.id])).toBe(false);
    ingestServerRequestMetrics(server.id, "   \n");
    expect(requestMetricsFresh([server.id])).toBe(false);
  });

  test("unknown service names are ignored", () => {
    const server = makeServer();
    ingestServerRequestMetrics(server.id, metricsFor("no-such-app", [{ code: "200", n: 1 }]));
    ingestServerRequestMetrics(server.id, metricsFor("no-such-app", [{ code: "200", n: 5 }]));
    // No throw, server still fresh.
    expect(requestMetricsFresh([server.id])).toBe(true);
  });
});

describe("requestMetricsFresh", () => {
  test("false for never-scraped servers, true within the window, false beyond it", () => {
    const server = makeServer();
    expect(requestMetricsFresh([server.id])).toBe(false);

    const t0 = Date.now();
    ingestServerRequestMetrics(server.id, "# ok\n", t0);
    expect(requestMetricsFresh([server.id], t0 + 1000)).toBe(true);
    expect(requestMetricsFresh([server.id], t0 + METRICS_FRESH_MS + 1)).toBe(false);
  });

  test("requires every listed server to be fresh", () => {
    const s1 = makeServer();
    const s2 = makeServer();
    ingestServerRequestMetrics(s1.id, "# ok\n");
    expect(requestMetricsFresh([s1.id])).toBe(true);
    expect(requestMetricsFresh([s1.id, s2.id])).toBe(false);
  });
});
