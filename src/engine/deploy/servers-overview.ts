import type { Server } from "../../shared/rpc.ts";
import * as db from "../../shared/db.ts";

type DbApp = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_mode: string;
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
  environment_id: number;
  environment_name: string;
};

/**
 * Aggregated view used by the dashboard and /api/servers. Per-server listing
 * of apps (active + sleeping) and services; enriched with host_port + the
 * username of whoever originally deployed each app.
 *
 * Kept here for legacy callers; safe to move if this file shrinks further.
 */
export function getServersWithApps(): any[] {
  const servers = db.getServers() as Server[];
  const allAppsGlobal = db.getApps() as DbApp[];
  return servers.map((s) => {
    const activeApps = db.getApps(s.id) as DbApp[];
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
        const instances = db.getServiceInstances(svc.id);
        const links = db.getServiceLinks(svc.id) as DbServiceLink[];
        return {
          ...svc,
          instance_count: instances.length,
          linked_environments: links.map((l) => ({ id: l.environment_id, name: l.environment_name })),
        };
      }),
    };
  });
}
