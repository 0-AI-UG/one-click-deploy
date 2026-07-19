import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

/**
 * GET /api/apps/:appId/availability?window=<seconds>
 *
 * Returns the app's availability SLO over the trailing window (uptime% + MTTR
 * from the sampled history) plus a live `current` snapshot recomputed from the
 * app's replicas right now, using the same predicate the sampler uses.
 */
export async function handleGetAvailability(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const url = new URL(request.url);
    const parsed = parseInt(url.searchParams.get("window") || "", 10);
    const windowSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 86400;

    const stats = db.getAvailabilityStats(appId, windowSec);

    // Live "current" snapshot — same computation as the reconciler sample.
    const running = db.getReplicas(appId).filter((r) => r.status === "running");
    const running_count = running.length;
    const distinct_hosts = new Set(running.map((r) => r.server_id)).size;
    const distinct_locations = new Set(
      running.map((r) => db.getServer(r.server_id)?.location).filter(Boolean),
    ).size;
    const meetsTarget = db.computeMeetsTarget({
      running_count,
      distinct_hosts,
      distinct_locations,
      min_replicas: app.min_replicas,
      min_locations: app.min_locations,
      max_per_host: app.max_per_host,
    });

    return Response.json(
      {
        uptimePct: stats.uptimePct,
        mttrSeconds: stats.mttrSeconds,
        sampleCount: stats.sampleCount,
        lastMeetsTarget: stats.lastMeetsTarget,
        current: {
          desired: app.desired_replicas,
          running: running_count,
          distinctHosts: distinct_hosts,
          distinctLocations: distinct_locations,
          meetsTarget,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
