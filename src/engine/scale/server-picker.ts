import * as db from "../../shared/db.ts";
import { provisionServer } from "../provision-server.ts";
import { type ProgressFn, type App, type Server } from "./types.ts";

export async function pickTargetServer(
  app: App,
  settings: Record<string, string>,
  emit: ProgressFn,
  preferredServerId?: number
): Promise<Server> {
  // Explicit placement: caller chose a specific server
  if (preferredServerId) {
    const preferred = db.getServer(preferredServerId) as Server | null;
    if (!preferred) throw new Error(`Target server ${preferredServerId} not found`);
    if (preferred.status !== "ready") throw new Error(`Target server ${preferred.name} is not ready (status: ${preferred.status})`);
    emit("scale", `Placing replica on ${preferred.name} (user-selected)`);
    return preferred;
  }

  // Capacity-aware placement: score each server by load + affinity and pick
  // the best candidate. Servers above 85% combined load are skipped.
  const allServers = db.getServers() as Server[];
  const appReplicas = db.getReplicas(app.id) as { server_id: number }[];
  const replicasByServer = new Map<number, number>();
  for (const r of appReplicas) {
    replicasByServer.set(r.server_id, (replicasByServer.get(r.server_id) || 0) + 1);
  }

  // Get recent server metrics for load scoring
  const recentMetrics = db.getRecentServerMetrics(120); // last 2 minutes
  const latestByServer = new Map<number, { cpu_percent: number; memory_percent: number }>();
  for (const m of recentMetrics) {
    latestByServer.set(m.server_id, { cpu_percent: m.cpu_percent, memory_percent: m.memory_percent });
  }

  const FULL_THRESHOLD = 0.85;
  const AFFINITY_PENALTY = 50;

  let bestServer: Server | null = null;
  let bestScore = Infinity;
  for (const server of allServers) {
    if (server.status !== "ready") continue;

    const metrics = latestByServer.get(server.id);
    // No metrics yet (new server) → treat as empty (load 0)
    const load = metrics
      ? (metrics.cpu_percent * 0.6 + metrics.memory_percent * 0.4) / 100
      : 0;

    // Skip servers that are above the full threshold
    if (load > FULL_THRESHOLD) continue;

    const appReplicaCount = replicasByServer.get(server.id) || 0;
    const score = load * 100 + appReplicaCount * AFFINITY_PENALTY;

    if (score < bestScore) {
      bestScore = score;
      bestServer = server;
    }
  }

  // If all servers are full or skipped, provision new
  if (!bestServer) {
    emit("scale", "Provisioning new server for replica...");

    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    // Default location: any existing replica's server, else configured default.
    const replicas = db.getReplicas(app.id);
    const anyReplicaServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
    const location = anyReplicaServer?.location || settings.default_location;

    return await provisionServer({
      serverType,
      location,
      name: `ocd-${app.name}-r${Date.now()}`,
      emit,
    });
  }

  return bestServer;
}
