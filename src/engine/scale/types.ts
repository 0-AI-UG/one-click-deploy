import * as db from "../../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow } from "../../shared/db.ts";
import { hashEnvironment, latestDesiredImage } from "../revision.ts";

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
    imageRef?: string;
    envFilePath?: string;
    envVars?: Record<string, string>;
  },
) {
  return {
    containerName: opts.containerName,
    // Candidate rollouts have pulled an exact digest that is intentionally
    // newer than deployment history.  Let that forward image bypass the
    // historical lookup; otherwise the first clean-cut release of a legacy
    // multi-replica app fails while replacing its extra replicas.
    image: opts.imageRef ?? latestDesiredImage(app),
    appName: app.name,
    // Initial deploys use startAppReplica's canonical ocd-net default. Keep
    // every reload/scale/recreate path on the same network.
    network: "ocd-net",
    bindAddr: replicaBindHost(server),
    hostPort: opts.hostPort,
    containerPort: app.container_port,
    envFilePath: opts.envFilePath,
    envVars: opts.envVars,
    configRevision: app.config_revision,
    envHash: opts.envVars ? hashEnvironment(opts.envVars) : undefined,
    volumeMount: app.volume_mount || undefined,
    extraVolumes: db.parseExtraVolumes(app.extra_volumes),
    memoryMb: app.memory_mb || undefined,
    cpus: app.cpu_limit || undefined,
    command: db.parseAppCommand(app),
    capAdd: db.parseAppCapabilities(app),
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
