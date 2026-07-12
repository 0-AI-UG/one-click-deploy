// Request-activity tracking from Traefik's Prometheus metrics. The reconciler
// scrapes every server's :8899 metrics endpoint once per tick (piggybacked on
// the batched stats SSH call) and feeds the raw text here. This module turns
// the per-server cumulative counters into per-app request deltas, persists
// apps.last_request_at / apps.requests_per_min, and answers the idle
// monitor's "is this data fresh enough to sleep on?" question.
//
// traefik_service_requests_total exists per (service, code, method, protocol)
// label set and only for HTTP services — the internal router (int-*) targets
// the same `app-<name>` service as the public router, so app-to-app traffic
// counts as activity and keeps callees awake.

import * as db from "../../shared/db.ts";

/** Sleep decisions may only rely on request data scraped this tick. A failed
 *  scrape means "unknown", never "zero traffic" — beyond this window the
 *  server counts as stale and apps with replicas there skip sleep (fail safe).
 *  1.5 reconciler ticks: a same-tick scrape is seconds old, a missed one ~30s+. */
export const METRICS_FRESH_MS = 45_000;

/** Window for the surfaced req/min figure (apps.requests_per_min). */
const RATE_WINDOW_MS = 60_000;
const SAMPLE_RETENTION_MS = 10 * 60_000;

// serverId -> (service name -> last-seen cumulative counter). Counters are
// per-server and reset when that server's Traefik restarts.
const lastCounters = new Map<number, Map<string, number>>();
// serverId -> timestamp of the last successful scrape.
const lastScrapeOkAt = new Map<number, number>();
// appId -> recent per-scrape deltas for the req/min window.
const recentDeltas = new Map<number, Array<{ at: number; n: number }>>();

const COUNTER_PREFIX = "traefik_service_requests_total{";

/** Sum traefik_service_requests_total across code/method/protocol label sets,
 *  keyed by service name with the `@file` provider suffix stripped. */
export function parseServiceRequestTotals(metricsText: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of metricsText.split("\n")) {
    if (!line.startsWith(COUNTER_PREFIX)) continue;
    const labelsEnd = line.indexOf("}");
    if (labelsEnd < 0) continue;
    const labels = line.slice(COUNTER_PREFIX.length, labelsEnd);
    const service = labels.match(/(?:^|,)service="([^"]+)"/)?.[1];
    if (!service) continue;
    const value = parseFloat(line.slice(labelsEnd + 1).trim());
    if (!Number.isFinite(value)) continue;
    const name = service.replace(/@file$/, "");
    totals.set(name, (totals.get(name) ?? 0) + value);
  }
  return totals;
}

/**
 * Ingest one server's scrape for this tick. `metricsText` is the raw
 * Prometheus exposition text, or null/empty when the scrape failed — in that
 * case the server is left stale on purpose (fail safe, see METRICS_FRESH_MS).
 */
export function ingestServerRequestMetrics(
  serverId: number,
  metricsText: string | null,
  now: number = Date.now(),
): void {
  if (!metricsText || !metricsText.trim()) return;
  const totals = parseServiceRequestTotals(metricsText);
  const prev = lastCounters.get(serverId);
  lastCounters.set(serverId, totals);
  lastScrapeOkAt.set(serverId, now);
  // First scrape after engine start: baseline only. The counters are
  // cumulative since Traefik start — a delta against nothing would count
  // historical requests as fresh activity.
  if (!prev) return;

  for (const [service, total] of totals) {
    if (!service.startsWith("app-")) continue;
    const before = prev.get(service);
    // Counter decreased => that server's Traefik restarted and the counter
    // reset, so the new value IS the delta. A series absent last scrape only
    // appears once it gets its first request, so its full value is new too.
    const delta = before === undefined || total < before ? total : total - before;
    const app = db.getAppByName(service.slice("app-".length));
    if (!app) continue;
    recordDelta(app.id, delta, now);
    if (delta > 0) db.touchAppLastRequest(app.id, now);
  }
}

function recordDelta(appId: number, delta: number, now: number): void {
  const samples = recentDeltas.get(appId) ?? [];
  samples.push({ at: now, n: delta });
  while (samples.length && samples[0].at < now - SAMPLE_RETENTION_MS) samples.shift();
  recentDeltas.set(appId, samples);
  const perMin = samples
    .filter((s) => s.at > now - RATE_WINDOW_MS)
    .reduce((sum, s) => sum + s.n, 0);
  db.updateAppRequestRate(appId, perMin);
}

/** True iff every listed server delivered a successful scrape within the
 *  freshness window — the precondition for a request-based sleep decision. */
export function requestMetricsFresh(serverIds: number[], now: number = Date.now()): boolean {
  return serverIds.every((id) => {
    const at = lastScrapeOkAt.get(id);
    return at !== undefined && now - at < METRICS_FRESH_MS;
  });
}

/** Test hook: clear all in-memory scrape state. */
export function resetRequestMetricsState(): void {
  lastCounters.clear();
  lastScrapeOkAt.clear();
  recentDeltas.clear();
}
