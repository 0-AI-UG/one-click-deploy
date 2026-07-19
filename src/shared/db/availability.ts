import db from "./connection.ts";

// --- App availability samples ---
// Periodic snapshots of whether an app met its durability/availability target,
// used to compute uptime% and MTTR (mean time to recovery). One row per
// reconciler evaluation; pruned on a retention window like the metrics tables.

export type AvailabilitySampleRow = {
  id: number;
  app_id: number;
  meets_target: number;
  desired_count: number;
  running_count: number;
  distinct_hosts: number;
  distinct_locations: number;
  sampled_at: string;
};

/**
 * Shared availability-target predicate. An app "meets target" when it has at
 * least its required number of replicas running, those running replicas span at
 * least `min_locations` distinct provider locations, and — when a per-host cap
 * is configured (`max_per_host > 0`) — they are spread across enough distinct
 * hosts to honour that cap (ceil(running / max_per_host) hosts).
 *
 * Lives here (a dependency-free helper) so BOTH the reconciler's periodic
 * sampler (src/engine/reconciler.ts) and the availability API route compute
 * `meets_target` identically without the engine importing server-route code.
 */
export function computeMeetsTarget(p: {
  running_count: number;
  distinct_hosts: number;
  distinct_locations: number;
  min_replicas: number;
  min_locations: number;
  max_per_host: number;
}): boolean {
  const target_replicas = Math.max(p.min_replicas, 1);
  return (
    p.running_count >= target_replicas &&
    p.distinct_locations >= p.min_locations &&
    (p.max_per_host === 0 || p.distinct_hosts >= Math.ceil(p.running_count / p.max_per_host))
  );
}

export function insertAvailabilitySample(s: {
  app_id: number;
  meets_target: boolean;
  desired_count: number;
  running_count: number;
  distinct_hosts: number;
  distinct_locations: number;
}): void {
  db.query(
    "INSERT INTO availability_samples (app_id, meets_target, desired_count, running_count, distinct_hosts, distinct_locations) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    s.app_id,
    s.meets_target ? 1 : 0,
    s.desired_count,
    s.running_count,
    s.distinct_hosts,
    s.distinct_locations,
  );
}

/**
 * Availability summary for an app over the trailing `sinceSeconds` window.
 *  - uptimePct: 100 * (samples meeting target) / total samples; 0 when no samples.
 *  - mttrSeconds: mean duration of downtime runs — each maximal span of
 *    consecutive meets_target=0 samples, measured from the sampled_at of the
 *    first failing sample to the sampled_at of the next passing sample. null when
 *    there were no recovered outages (never failed, or still down at window end).
 *  - sampleCount: number of samples in the window.
 *  - lastMeetsTarget: meets_target of the newest sample (null when no samples).
 */
export function getAvailabilityStats(
  appId: number,
  sinceSeconds: number,
): { uptimePct: number; mttrSeconds: number | null; sampleCount: number; lastMeetsTarget: boolean | null } {
  const rows = db
    .query(
      `SELECT meets_target, sampled_at
       FROM availability_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`,
    )
    .all(appId, `-${sinceSeconds} seconds`) as Array<{ meets_target: number; sampled_at: string }>;

  const sampleCount = rows.length;
  if (sampleCount === 0) {
    return { uptimePct: 0, mttrSeconds: null, sampleCount: 0, lastMeetsTarget: null };
  }

  const meetsCount = rows.reduce((acc, r) => acc + (r.meets_target ? 1 : 0), 0);
  const uptimePct = 100 * (meetsCount / sampleCount);

  // Walk the ordered samples, collecting the duration of each downtime run that
  // recovered (a passing sample follows a failing run). A run still open at the
  // end of the window is not counted (no recovery observed yet).
  const recoveryDurations: number[] = [];
  let outageStart: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.sampled_at + "Z"); // sampled_at is a UTC datetime('now') string
    if (!r.meets_target) {
      if (outageStart === null) outageStart = t;
    } else if (outageStart !== null) {
      recoveryDurations.push((t - outageStart) / 1000);
      outageStart = null;
    }
  }

  const mttrSeconds =
    recoveryDurations.length > 0
      ? recoveryDurations.reduce((a, b) => a + b, 0) / recoveryDurations.length
      : null;

  const lastMeetsTarget = rows[rows.length - 1].meets_target === 1;

  return { uptimePct, mttrSeconds, sampleCount, lastMeetsTarget };
}

export function pruneOldAvailabilitySamples(olderThanSeconds: number): void {
  db.query(
    "DELETE FROM availability_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}
