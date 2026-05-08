import type { Server } from "../../shared/rpc.ts";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";

type DbApp = AppRow & {
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  deployed_by: string | null;
};

type DbReplica = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
};

type DbService = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
};

type DbServiceLink = {
  app_id: number;
  app_name: string;
};

export type ServerWithApps = Server & {
  apps: Array<DbApp & {
    host_port: number;
    servers: number[];
    deployed_by_username: string | null;
  }>;
  services: Array<DbService & {
    instance_count: number;
    linked_apps: Array<{ id: number; name: string }>;
  }>;
};

/**
 * Aggregated view used by the dashboard and /api/servers. Per-server listing
 * of apps (active + sleeping) and services; enriched with host_port + the
 * username of whoever originally deployed each app.
 *
 * Kept here for legacy callers; safe to move if this file shrinks further.
 */
export function getServersWithApps(orgId = ""): ServerWithApps[] {
  const servers = db.getServers(orgId) as Server[];
  const allAppsGlobal = db.getApps(orgId) as DbApp[];
  return servers.map((s) => {
    const activeApps = db.getApps(orgId, s.id) as DbApp[];
    const sleepingApps = allAppsGlobal.filter(
      (a) => a.sleeping_server_id === s.id && !activeApps.some((aa) => aa.id === a.id),
    );
    const allApps = [...activeApps, ...sleepingApps];
    return {
      ...s,
      apps: allApps.map((a) => {
        const reps = db.getReplicas(a.id) as DbReplica[];
        const first = reps[0];
        const serverIds = Array.from(new Set(reps.map((r) => r.server_id)));
        const deployedByUser = a.deployed_by ? db.getUserById(a.deployed_by) : null;
        return {
          ...a,
          host_port: first?.host_port ?? a.sleeping_host_port ?? 0,
          servers: serverIds,
          deployed_by_username: deployedByUser?.username || null,
        };
      }),
      services: (db.getServicesOnServer(s.id) as DbService[]).map((svc) => {
        const instances = db.getServiceInstancesUnscoped(svc.id);
        const links = db.getServiceLinksUnscoped(svc.id) as DbServiceLink[];
        return {
          ...svc,
          instance_count: instances.length,
          linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name })),
        };
      }),
    };
  });
}
