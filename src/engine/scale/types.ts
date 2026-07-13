import * as db from "../../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow } from "../../shared/db.ts";

export type ProgressFn = (step: string, detail: string) => void;

// The scale engine operates directly on the shared DB row types — single-source
// the columns rather than hand-re-enumerating them here.
export type App = AppRow;
export type Replica = ReplicaRow;
export type Server = ServerRow;

export function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [scale:${context}]`, ...args);
}

/**
 * Shared `startAppReplica` options for the FORWARD-create paths (scale-up,
 * wake, rolling redeploy, health recreate) that source everything from the
 * live app row. Snapshot/compensation paths (rollback, redeploy) source from a
 * captured snapshot instead and build their own options. Pass one of
 * `envFilePath` (pre-existing file) or `envVars` (rewritten from the DB).
 */
export function appReplicaRunOpts(
  app: App,
  server: Server,
  opts: {
    containerName: string;
    hostPort: number;
    envFilePath?: string;
    envVars?: Record<string, string>;
  },
) {
  return {
    containerName: opts.containerName,
    image: `${app.name}:latest`,
    appName: app.name,
    network: null as string | null, // replicas historically don't join ocd-net
    bindAddr: replicaBindHost(server),
    hostPort: opts.hostPort,
    containerPort: app.container_port,
    envFilePath: opts.envFilePath,
    envVars: opts.envVars,
    volumeMount: app.volume_mount || undefined,
    extraVolumes: db.parseExtraVolumes(app.extra_volumes),
    memoryMb: app.memory_mb || undefined,
    cpus: app.cpu_limit || undefined,
  };
}

/**
 * The address a tenant server's replica containers are bound to — always
 * the server's private IPv4 on the shared `ocd-net` network. Throws if
 * unset so misconfigured servers fail fast at deploy time instead of
 * silently publishing to the public NIC.
 */
export function replicaBindHost(server: { name: string; private_ipv4: string }): string {
  if (!server.private_ipv4) {
    throw new Error(
      `Server ${server.name} has no private_ipv4 — wait for the network reconciler to attach it before deploying`,
    );
  }
  return server.private_ipv4;
}
