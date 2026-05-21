import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";

/**
 * Aggregate endpoint feeding the graph view. Single round-trip so the frontend
 * can render every node + edge without sequential fetches.
 */
export async function handleGetGraph(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");

    const servers = db.getServers().map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      type: s.type,
      location: s.location,
      ipv4: s.ipv4,
    }));

    const apps = db.getApps().map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      domain: a.domain,
      environment_id: a.environment_id ?? null,
      volume_id: a.volume_id || null,
      desired_replicas: a.desired_replicas,
    }));

    const services = db.getServices().map((s) => ({
      id: s.id,
      name: s.name,
      service_type: s.service_type,
      version: s.version,
      status: s.status,
    }));

    const environments = db.getEnvironments().map((e) => {
      let var_count = 0;
      try {
        const parsed = JSON.parse(e.env_vars || "[]");
        if (Array.isArray(parsed)) var_count = parsed.length;
        else if (parsed && typeof parsed === "object") var_count = Object.keys(parsed).length;
      } catch {
        var_count = 0;
      }
      return { id: e.id, name: e.name, var_count };
    });

    const replicas = db.getAllReplicas().map((r) => ({
      id: r.id,
      app_id: r.app_id,
      server_id: r.server_id,
      status: r.status,
    }));

    const service_instances = db.getAllServiceInstances().map((i) => ({
      id: i.id,
      service_id: i.service_id,
      server_id: i.server_id,
      status: i.status,
    }));

    // service_links is per-service in the db helper; aggregate across all services.
    const service_links: Array<{ service_id: number; environment_id: number; env_prefix: string }> = [];
    for (const svc of services) {
      const links = db.getServiceLinks(svc.id);
      for (const l of links) {
        service_links.push({
          service_id: l.service_id,
          environment_id: l.environment_id,
          env_prefix: l.env_prefix,
        });
      }
    }

    // Volumes live in the compute provider, not the local db. The graph still
    // wants them as nodes so app→volume edges have something to point at.
    // Fail-soft if the provider is unreachable.
    type VolumeNode = { id: string; name: string; size_gb: number; location: string };
    let volumes: VolumeNode[] = [];
    try {
      const compute = getComputeProvider();
      const vols = (await compute.volumes?.list()) ?? [];
      const referenced = new Set(apps.map((a) => a.volume_id).filter(Boolean) as string[]);
      volumes = vols
        .filter((v) => referenced.has(v.providerId))
        .map((v) => ({ id: v.providerId, name: v.name, size_gb: v.sizeGb, location: v.location }));
    } catch (e) {
      console.error("graph: failed to list volumes:", e);
    }

    return Response.json(
      { servers, apps, services, environments, volumes, replicas, service_instances, service_links },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
