import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { destroyServer } from "../../bun/deploy/index.ts";
import * as hetzner from "../../bun/hetzner/index.ts";

export async function handleGetResources(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");

    // Fetch Hetzner pricing once and build lookup maps. Hetzner returns gross
    // prices as strings; we coerce to number and round to cents for display.
    // If pricing fetch fails (no token, network), monthly_eur falls back to null.
    let serverPriceMap = new Map<string, number>(); // `${type}|${location}` -> EUR/mo
    let lbPriceMap = new Map<string, number>();
    let volumePerGbMonth: number | null = null;
    let currency = "EUR";
    try {
      const pricing = await hetzner.hetznerApi("/pricing");
      const p = pricing.pricing || {};
      currency = p.currency || "EUR";
      for (const st of p.server_types || []) {
        for (const pr of st.prices || []) {
          const eur = parseFloat(pr.price_monthly?.gross ?? "0");
          if (!isNaN(eur)) serverPriceMap.set(`${st.name}|${pr.location}`, eur);
        }
      }
      for (const lt of p.load_balancer_types || []) {
        for (const pr of lt.prices || []) {
          const eur = parseFloat(pr.price_monthly?.gross ?? "0");
          if (!isNaN(eur)) lbPriceMap.set(`${lt.name}|${pr.location}`, eur);
        }
      }
      const v = parseFloat(p.volume?.price_per_gb_month?.gross ?? "");
      if (!isNaN(v)) volumePerGbMonth = v;
    } catch (e) {
      console.error("resources: failed to fetch Hetzner pricing:", e);
    }

    const priceForServer = (type: string, location: string): number | null =>
      serverPriceMap.get(`${type}|${location}`) ?? null;
    const priceForLb = (type: string, location: string): number | null =>
      lbPriceMap.get(`${type}|${location}`) ?? null;

    let dbServers = db.getServers();
    try {
      const remote = await hetzner.hetznerApiPublic("/servers?label_selector=managed_by%3Done-click-deploy&per_page=50");
      for (const rs of remote.servers || []) {
        const hetznerId = String(rs.id);
        if (dbServers.find((s: any) => s.hetzner_id === hetznerId)) continue;
        db.insertServer({
          name: rs.name,
          hetzner_id: hetznerId,
          ipv4: rs.public_net?.ipv4?.ip || "",
          ipv6: rs.public_net?.ipv6?.ip || "",
          type: rs.server_type?.name || "",
          location: rs.datacenter?.location?.name || "",
          status: rs.status || "running",
        });
      }
      dbServers = db.getServers();
    } catch (e) {
      console.error("resources: failed to sync servers from Hetzner:", e);
    }
    const servers = dbServers.map((s: any) => ({
      id: s.id,
      name: s.name,
      hetzner_id: s.hetzner_id,
      ipv4: s.ipv4,
      type: s.type,
      location: s.location,
      status: s.status,
      replica_count: db.getReplicasByServer(s.id).length,
      monthly_eur: priceForServer(s.type, s.location),
    }));

    let load_balancers: any[] = [];
    try {
      const lbs = await hetzner.hetznerApiPublic("/load_balancers?label_selector=managed_by%3Done-click-deploy&per_page=50");
      load_balancers = (lbs.load_balancers || []).map((lb: any) => {
        const type = lb.load_balancer_type?.name || "lb11";
        const location = lb.location?.name || "";
        return {
          id: String(lb.id),
          name: lb.name,
          ipv4: lb.public_net?.ipv4?.ip || "",
          type,
          location,
          app_name: lb.labels?.app || "",
          targets: lb.targets?.length || 0,
          monthly_eur: priceForLb(type, location),
        };
      });
    } catch (e) {
      console.error("resources: failed to fetch load balancers from Hetzner:", e);
    }

    let volumes: any[] = [];
    try {
      const vols = await hetzner.hetznerApiPublic("/volumes?label_selector=managed_by%3Done-click-deploy&per_page=50");
      volumes = (vols.volumes || []).map((v: any) => {
        const serverName = v.server ? dbServers.find((s: any) => s.hetzner_id === String(v.server))?.name || `server-${v.server}` : "";
        const allApps = db.getApps();
        const app = allApps.find((a: any) => a.volume_id === String(v.id));
        return {
          id: String(v.id),
          name: v.name,
          size: v.size,
          server_name: serverName,
          app_name: app?.name || "",
          location: v.location?.name || "",
          app_id: app?.id || 0,
          monthly_eur: volumePerGbMonth != null ? volumePerGbMonth * v.size : null,
        };
      });
    } catch (e) {
      console.error("resources: failed to fetch volumes from Hetzner:", e);
    }

    const sum = (arr: any[]) =>
      arr.reduce((acc, x) => acc + (typeof x.monthly_eur === "number" ? x.monthly_eur : 0), 0);
    const totals = {
      currency,
      servers: sum(servers),
      load_balancers: sum(load_balancers),
      volumes: sum(volumes),
      total: sum(servers) + sum(load_balancers) + sum(volumes),
    };

    return Response.json({ servers, load_balancers, volumes, totals }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteResource(request: Request, type: string, id: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.delete");

    if (type === "server") {
      const server = db.getServers().find((s: any) => s.hetzner_id === id || String(s.id) === id);
      if (server) {
        const replicas = db.getReplicasByServer(server.id);
        if (replicas.length > 0) {
          const users = replicas.map((r: any) => `${r.container_name} (replica)`);
          return Response.json({ ok: false, error: `Server is in use by: ${users.join(", ")}` }, { headers: corsHeaders });
        }
        const result = await destroyServer(server.id);
        return Response.json(result, { headers: corsHeaders });
      }
      await hetzner.deleteHetznerServer(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    } else if (type === "load_balancer") {
      const apps = db.getApps();
      const using = apps.filter((a: any) => a.hetzner_lb_id === id);
      if (using.length > 0) {
        return Response.json({ ok: false, error: `Load balancer is in use by: ${using.map((a: any) => a.name).join(", ")}` }, { headers: corsHeaders });
      }
      await hetzner.deleteLoadBalancer(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    } else if (type === "volume") {
      const allApps = db.getApps();
      const using = allApps.filter((a: any) => a.volume_id === id);
      if (using.length > 0) {
        return Response.json({ ok: false, error: `Volume is in use by: ${using.map((a: any) => a.name).join(", ")}` }, { headers: corsHeaders });
      }
      await hetzner.deleteVolume(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    return Response.json({ ok: false, error: "Unknown resource type" }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
