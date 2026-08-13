import * as db from "../../shared/db.ts";
import { provisionServer } from "../provision-server.ts";
import { type ProgressFn, type App, type Server } from "./types.ts";

export async function pickTargetServer(
  app: App,
  settings: Record<string, string>,
  emit: ProgressFn,
  preferredServerId?: number,
  // Replicas of THIS app already decided earlier in the same converge/scale
  // pass but not necessarily persisted yet (server_id → count). Lets a single
  // scale 1→3 spread across hosts/locations instead of stacking on one host.
  plannedByServer?: Map<number, number>,
  allowServerProvisioning = false,
  /** Stable owner suffix supplied by an engine operation for crash adoption. */
  provisioningKey?: string,
): Promise<Server> {
  // Explicit placement: caller chose a specific server
  if (preferredServerId) {
    const preferred = db.getServer(preferredServerId);
    if (!preferred) throw new Error(`Target server ${preferredServerId} not found`);
    if (preferred.status !== "ready") throw new Error(`Target server ${preferred.name} is not ready (status: ${preferred.status})`);
    emit("scale", `Placing replica on ${preferred.name} (user-selected)`);
    return preferred;
  }

  // Capacity-aware placement: score each server by load + affinity and pick
  // the best candidate. Servers above 85% combined load are skipped.
  const allServers = db.getServers();
  const panelServerId = db.getPanel()?.server_id;
  const serverById = new Map(allServers.map((s) => [s.id, s] as const));
  const appReplicas = db.getReplicas(app.id);
  const replicasByServer = new Map<number, number>();
  for (const r of appReplicas) {
    replicasByServer.set(r.server_id, (replicasByServer.get(r.server_id) || 0) + 1);
  }

  // Distinct locations this app already covers = locations of its existing
  // replicas plus any decided-but-unpersisted placements in this pass. The Set
  // dedupes, so overlap between DB rows and planned picks is harmless.
  const coveredLocations = new Set<string>();
  for (const r of appReplicas) {
    const s = serverById.get(r.server_id);
    if (s) coveredLocations.add(s.location);
  }
  if (plannedByServer) {
    for (const [sid, count] of plannedByServer) {
      if (count > 0) {
        const s = serverById.get(sid);
        if (s) coveredLocations.add(s.location);
      }
    }
  }
  // Durability spread: this app wants replicas across >= min_locations distinct
  // locations and hasn't reached that yet. Default apps (min_locations=1) never
  // trip this and keep today's behavior exactly.
  const needSpread = app.min_locations > 1 && coveredLocations.size < app.min_locations;

  // Get recent server metrics for load scoring
  const recentMetrics = db.getRecentServerMetrics(120); // last 2 minutes
  const latestByServer = new Map<number, { cpu_percent: number; memory_percent: number }>();
  for (const m of recentMetrics) {
    latestByServer.set(m.server_id, { cpu_percent: m.cpu_percent, memory_percent: m.memory_percent });
  }

  const FULL_THRESHOLD = 0.85;
  const AFFINITY_PENALTY = 50;
  // Large enough to dwarf any load/affinity score, so among valid candidates an
  // uncovered-location server always beats a covered-location one when spreading.
  const LOCATION_PENALTY = 1_000_000;

  let bestServer: Server | null = null;
  let bestScore = Infinity;
  for (const server of allServers) {
    if (server.status !== "ready") continue;
    // The control-plane host is a reserved failure domain. Explicit placement
    // above may still opt into it, but automatic scheduling never does.
    if (server.id === panelServerId) continue;
    // Pool filter: an app only schedules onto servers in its placement pool.
    // Default apps and servers both live in 'general', so this is a no-op there.
    if (server.pool !== app.placement_pool) continue;

    const metrics = latestByServer.get(server.id);
    // No metrics yet (new server) → treat as empty (load 0)
    const load = metrics
      ? (metrics.cpu_percent * 0.6 + metrics.memory_percent * 0.4) / 100
      : 0;

    // Skip servers that are above the full threshold
    if (load > FULL_THRESHOLD) continue;

    const dbCount = replicasByServer.get(server.id) || 0;
    const effectiveCount = dbCount + (plannedByServer?.get(server.id) || 0);

    // Hard anti-affinity: never exceed the app's per-host replica cap. Only
    // active when max_per_host > 0; max_per_host=0 (default) means unlimited.
    if (app.max_per_host > 0 && effectiveCount >= app.max_per_host) continue;

    let score = load * 100;
    // Soft spread for uncapped (default) apps only — preserves today's exact
    // affinity behavior. Uses the persisted count, which already reflects
    // earlier picks in this pass (scale-up inserts each replica before the
    // next pick), so it prevents stacking without a hard cap.
    if (app.max_per_host === 0) score += dbCount * AFFINITY_PENALTY;
    // Multi-location durability: push already-covered locations to the back so
    // an uncovered-location candidate always wins when spread is still needed.
    if (needSpread && coveredLocations.has(server.location)) score += LOCATION_PENALTY;

    if (score < bestScore) {
      bestScore = score;
      bestServer = server;
    }
  }

  // A distinct location is required but every valid candidate is in an
  // already-covered location → provision a fresh server in an uncovered one
  // rather than defeating the spread requirement.
  if (needSpread && bestServer && coveredLocations.has(bestServer.location)) {
    bestServer = null;
  }

  // If all servers are full/excluded, provision new
  if (!bestServer) {
    emit("scale", "Provisioning new server for replica...");

    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");

    let location: string;
    if (needSpread) {
      // Land the new server in a location this app doesn't yet cover so its
      // replicas span >= min_locations. Draw from known server locations
      // (any pool) plus the configured default.
      const knownLocations = new Set(allServers.map((s) => s.location));
      if (settings.default_location) knownLocations.add(settings.default_location);
      const uncovered = [...knownLocations].find((loc) => loc && !coveredLocations.has(loc));
      location = uncovered || settings.default_location || allServers[0]?.location || "";
    } else {
      // Default location: any existing replica's server, else configured default.
      const anyReplicaServer = appReplicas[0] ? db.getServer(appReplicas[0].server_id) : null;
      location = anyReplicaServer?.location || settings.default_location;
    }

    return await provisionServer({
      serverType,
      location,
      name: provisioningKey
        ? `ocd-${app.name}-${provisioningKey}`
        : `ocd-${app.name}-r${Date.now()}`,
      // Join the app's placement pool so future picks see it as a candidate.
      pool: app.placement_pool,
      approved: allowServerProvisioning,
      emit,
    });
  }

  return bestServer;
}
