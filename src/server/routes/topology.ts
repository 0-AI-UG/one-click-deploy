import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { parseEnvVars } from "../../shared/env-crypto.ts";
import * as db from "../../shared/db.ts";

// Matches an internal service address like `http://bc-worker.ocd.internal:20011`
// or `tcp://bc-postgres.ocd.internal:20009` and captures the app name.
const INTERNAL_HOST_RE = /(?:https?|tcp):\/\/([a-z0-9-]+)\.ocd\.internal/gi;

export type TopologyServer = {
  id: number; name: string; ipv4: string; private_ipv4: string | null;
  type: string | null; location: string | null; isPanel: boolean;
};
export type TopologyApp = {
  id: number; name: string; status: string; public: 0 | 1; domain: string | null;
  internal_port: number | null; internal_protocol: string; sticky: boolean;
  stack_id: number | null; stack_name: string | null; desired_replicas: number;
};
export type TopologyReplica = {
  id: number; app_id: number; server_id: number; host_port: number | null;
  status: string; container_name: string;
};
// A link A→B derived from an env var on A whose value points at B's internal host.
// `sharedEnv` is true when A and B share one environment (a stack): the platform
// injects every member's URL into that env, so the reference proves reachability
// but not a real per-app dependency (stack `needs` is not persisted).
export type TopologyLink = { from: number; to: number; key: string; sharedEnv: boolean };
export type TopologyData = {
  panelServerId: number | null;
  servers: TopologyServer[];
  apps: TopologyApp[];
  replicas: TopologyReplica[];
  links: TopologyLink[];
};

export async function handleGetTopology(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");

    const panelServerId = db.getPanel()?.server_id ?? null;
    const servers: TopologyServer[] = db.getServers().map((s) => ({
      id: s.id, name: s.name, ipv4: s.ipv4, private_ipv4: s.private_ipv4 ?? null,
      type: s.type ?? null, location: s.location ?? null, isPanel: s.id === panelServerId,
    }));

    const stackName = new Map(db.getStacks().map((s) => [s.id, s.name]));
    const allApps = db.getApps();
    const appByName = new Map(allApps.map((a) => [a.name, a]));

    const apps: TopologyApp[] = allApps.map((a) => ({
      id: a.id, name: a.name, status: a.status,
      public: a.public ? 1 : 0, domain: a.domain || null,
      internal_port: a.internal_port ?? null,
      internal_protocol: a.internal_protocol === "tcp" ? "tcp" : "http",
      sticky: !!(a as { sticky?: number | boolean }).sticky,
      stack_id: a.stack_id ?? null,
      stack_name: a.stack_id != null ? (stackName.get(a.stack_id) ?? null) : null,
      desired_replicas: a.desired_replicas ?? 1,
    }));

    const replicas: TopologyReplica[] = db.getAllReplicas().map((r) => ({
      id: r.id, app_id: r.app_id, server_id: r.server_id,
      host_port: r.host_port ?? null, status: r.status, container_name: r.container_name,
    }));

    // Derive app→app links from non-secret env values referencing `<app>.ocd.internal`.
    // Parse each distinct environment once (stacks share one env across all members).
    const envEntries = new Map<number, Array<{ key: string; value: string }>>();
    const entriesFor = (envId: number) => {
      const cached = envEntries.get(envId);
      if (cached) return cached;
      let entries: Array<{ key: string; value: string }> = [];
      try {
        const env = db.getEnvironment(envId);
        if (env) {
          entries = parseEnvVars(env.env_vars).entries
            .filter((e) => !e.secret && e.value)
            .map((e) => ({ key: e.key, value: e.value }));
        }
      } catch { /* unreadable env — skip */ }
      envEntries.set(envId, entries);
      return entries;
    };

    const links: TopologyLink[] = [];
    const seen = new Set<string>();
    for (const a of allApps) {
      const envId = (a as { environment_id?: number | null }).environment_id;
      if (envId == null) continue;
      for (const e of entriesFor(envId)) {
        INTERNAL_HOST_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INTERNAL_HOST_RE.exec(e.value)) !== null) {
          const target = appByName.get(m[1]);
          if (!target || target.id === a.id) continue;
          const k = `${a.id}->${target.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const sharedEnv = (target as { environment_id?: number | null }).environment_id === envId;
          links.push({ from: a.id, to: target.id, key: e.key, sharedEnv });
        }
      }
    }

    const data: TopologyData = { panelServerId, servers, apps, replicas, links };
    return Response.json(data, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
