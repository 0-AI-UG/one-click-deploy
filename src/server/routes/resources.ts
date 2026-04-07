import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { destroyServer } from "../../bun/deploy/index.ts";
import * as hetzner from "../../bun/hetzner/index.ts";

export async function handleGetResources(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");

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
    } catch {}
    const servers = dbServers.map((s: any) => ({
      id: s.id,
      name: s.name,
      hetzner_id: s.hetzner_id,
      ipv4: s.ipv4,
      type: s.type,
      location: s.location,
      status: s.status,
      app_count: db.getApps(s.id).length,
      replica_count: db.getReplicasByServer(s.id).length,
    }));

    let load_balancers: any[] = [];
    try {
      const lbs = await hetzner.hetznerApiPublic("/load_balancers?label_selector=managed_by%3Done-click-deploy&per_page=50");
      load_balancers = (lbs.load_balancers || []).map((lb: any) => ({
        id: String(lb.id),
        name: lb.name,
        ipv4: lb.public_net?.ipv4?.ip || "",
        type: lb.load_balancer_type?.name || "lb11",
        location: lb.location?.name || "",
        app_name: lb.labels?.app || "",
        targets: lb.targets?.length || 0,
      }));
    } catch {}

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
        };
      });
    } catch {}

    return Response.json({ servers, load_balancers, volumes }, { headers: corsHeaders });
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
        const apps = db.getApps(server.id);
        const replicas = db.getReplicasByServer(server.id);
        if (apps.length > 0 || replicas.length > 0) {
          const users = [
            ...apps.map((a: any) => a.name),
            ...replicas.map((r: any) => `${r.container_name} (replica)`),
          ];
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
