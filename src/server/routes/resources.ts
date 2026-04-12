import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { destroyServer } from "../../bun/deploy/index.ts";
import { getComputeProvider } from "../../bun/providers/index.ts";
export async function handleGetResources(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");

    const compute = getComputeProvider();

    // Fetch pricing once and build lookup maps.
    // If pricing fetch fails (no token, network), monthly_eur falls back to null.
    let serverPriceMap = new Map<string, number>();
    let volumePerGbMonth: number | null = null;
    let currency = "EUR";
    try {
      const pricing = await compute.getPricing?.();
      if (pricing) {
        currency = pricing.currency;
        for (const [key, value] of Object.entries(pricing.servers)) {
          serverPriceMap.set(key, value);
        }
        volumePerGbMonth = pricing.volumePerGbMonth;
      }
    } catch (e) {
      console.error("resources: failed to fetch pricing:", e);
    }

    const priceForServer = (type: string, location: string): number | null =>
      serverPriceMap.get(`${type}|${location}`) ?? null;
    let dbServers = db.getServers();
    try {
      const remoteServers = await compute.listServers();
      for (const rs of remoteServers) {
        const providerId = String(rs.providerId);
        if (dbServers.find((s) => s.provider_id === providerId)) continue;
        db.insertServer({
          name: rs.name,
          provider_id: providerId,
          ipv4: rs.ipv4 || "",
          ipv6: rs.ipv6 || "",
          type: rs.type || "",
          location: rs.location || "",
          status: rs.status || "running",
        });
      }
      dbServers = db.getServers();
    } catch (e) {
      console.error("resources: failed to sync servers from provider:", e);
    }

    // Get latest metric sample per server from the reconciler-collected history
    const recentMetrics = db.getRecentServerMetrics(120); // last 2 minutes
    const latestByServer = new Map<number, { cpu_percent: number; memory_percent: number }>();
    for (const m of recentMetrics) {
      latestByServer.set(m.server_id, { cpu_percent: m.cpu_percent, memory_percent: m.memory_percent });
    }

    const servers = dbServers.map((s) => {
      const usage = latestByServer.get(s.id);
      return {
        id: s.id,
        name: s.name,
        provider_id: s.provider_id,
        ipv4: s.ipv4,
        type: s.type,
        location: s.location,
        status: s.status,
        cpu_percent: usage?.cpu_percent ?? null,
        memory_percent: usage?.memory_percent ?? null,
        replica_count: db.getReplicasByServer(s.id).length,
        monthly_eur: priceForServer(s.type, s.location),
      };
    });

    interface VolumeResource {
      id: string;
      name: string;
      size: number;
      server_name: string;
      app_name: string;
      location: string;
      app_id: number;
      monthly_eur: number | null;
    }

    let volumes: VolumeResource[] = [];
    try {
      const vols = await compute.volumes?.list() ?? [];
      const allApps = db.getApps();
      volumes = vols.map((v) => {
        const serverName = v.serverId ? dbServers.find((s) => s.provider_id === v.serverId)?.name || `server-${v.serverId}` : "";
        const app = allApps.find((a) => a.volume_id === v.providerId);
        return {
          id: v.providerId,
          name: v.name,
          size: v.sizeGb,
          server_name: serverName,
          app_name: app?.name || "",
          location: v.location,
          app_id: app?.id || 0,
          monthly_eur: volumePerGbMonth != null ? volumePerGbMonth * v.sizeGb : null,
        };
      });
    } catch (e) {
      console.error("resources: failed to fetch volumes:", e);
    }

    interface ResourceWithCost { monthly_eur: number | null }
    const sum = (arr: ResourceWithCost[]) =>
      arr.reduce((acc, x) => acc + (typeof x.monthly_eur === "number" ? x.monthly_eur : 0), 0);
    const totals = {
      currency,
      servers: sum(servers),
      volumes: sum(volumes),
      total: sum(servers) + sum(volumes),
    };

    return Response.json({ servers, volumes, totals }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServerMetricsHistory(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "3600", 10);
    const samples = db.getRecentServerMetrics(since);
    return Response.json(samples, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteResource(request: Request, type: string, id: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.delete");
    const compute = getComputeProvider();

    if (type === "server") {
      const server = db.getServers().find((s) => s.provider_id === id || String(s.id) === id);
      if (server) {
        const replicas = db.getReplicasByServer(server.id);
        if (replicas.length > 0) {
          const users = replicas.map((r) => `${r.container_name} (replica)`);
          return Response.json({ ok: false, error: `Server is in use by: ${users.join(", ")}` }, { headers: corsHeaders });
        }
        const result = await destroyServer(server.id);
        return Response.json(result, { headers: corsHeaders });
      }
      await compute.deleteServer(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    } else if (type === "volume") {
      const allApps = db.getApps();
      const using = allApps.filter((a) => a.volume_id === id);
      if (using.length > 0) {
        return Response.json({ ok: false, error: `Volume is in use by: ${using.map((a) => a.name).join(", ")}` }, { headers: corsHeaders });
      }
      await compute.volumes!.delete(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    return Response.json({ ok: false, error: "Unknown resource type" }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
