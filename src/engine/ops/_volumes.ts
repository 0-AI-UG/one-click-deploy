import * as db from "../../shared/db.ts";
import { requireStorageDriver } from "../storage/index.ts";

type EnsureOpts = Parameters<ReturnType<typeof requireStorageDriver>["ensureMount"]>[0];
type RemoveOpts = Parameters<ReturnType<typeof requireStorageDriver>["removeMount"]>[0];
let testEnsure: ((opts: EnsureOpts) => Promise<void>) | undefined;
let testRemove: ((opts: RemoveOpts) => Promise<void>) | undefined;

/** Test-only seam around the provider-neutral mount boundary. */
export function __setBindImplForTest(impl: {
  ensureVolumeBindMount?: (opts: any) => Promise<void>;
  removeVolumeBindMount?: (opts: any) => Promise<void>;
}) {
  if (impl.ensureVolumeBindMount) testEnsure = impl.ensureVolumeBindMount;
  if (impl.removeVolumeBindMount) testRemove = impl.removeVolumeBindMount;
}
export function __resetBindImplForTest() {
  testEnsure = undefined;
  testRemove = undefined;
}

// Shared helpers for the volume-management ops (attach / attach-existing /
// detach / reattach). These mirror the exact host-mount + precondition
// conventions the old HTTP handlers used, so the behaviour is preserved
// byte-for-byte — only the orchestration (steps + compensation) is new.

export type SingleReplicaTarget = {
  serverId: number;
  providerServerId: string;
  serverIp: string;
  serverLocation: string;
  /** "" when the server has no captured host key. */
  hostKey: string;
  appName: string;
};

/**
 * Authoritative precondition load for the single-replica volume ops. Throws
 * with the same user-facing strings the routes used, so the op fails loudly
 * (TOCTOU-safe) if the cheap route-level checks raced an engine op.
 */
export function loadSingleReplicaTarget(
  appId: number,
  opts: { requireNoVolume: boolean },
): SingleReplicaTarget {
  const app = db.getApp(appId);
  if (!app) throw new Error("App not found");
  if (opts.requireNoVolume && app.volume_id) {
    throw new Error("App already has a volume attached");
  }
  const reps = db.getReplicas(appId);
  if (reps.length === 0) throw new Error("App has no replicas");
  if (reps.length > 1) {
    throw new Error("Cannot attach a volume to an app with more than 1 replica. Scale down to 1 first.");
  }
  const server = db.getServer(reps[0].server_id);
  if (!server) throw new Error("Server not found");
  return {
    serverId: server.id,
    providerServerId: server.provider_id,
    serverIp: server.ipv4,
    serverLocation: server.location,
    hostKey: server.ssh_host_key || "",
    appName: app.name,
  };
}

/**
 * Set up the host bind mount through the selected storage driver. Idempotent:
 * safe to replay after a crash.
 */
export async function ensureBindMount(opts: {
  serverId: number;
  driverId: string;
  volumeId: string;
  hostMountPath: string;
  appId: number;
}): Promise<void> {
  const server = db.getServer(opts.serverId);
  if (!server) throw new Error("Server not found");
  const input = {
    server,
    volumeId: opts.volumeId,
    hostPath: opts.hostMountPath,
    blockName: `app-${opts.appId}`,
  };
  if (testEnsure) await testEnsure(input);
  else await requireStorageDriver(opts.driverId).ensureMount(input);
}

/** Teardown of a host bind mount. Idempotent, but surfaces SSH failures. */
export async function removeBindMount(opts: {
  serverId: number;
  driverId: string;
  volumeId: string;
  hostMountPath: string;
  appId: number;
}): Promise<void> {
  const server = db.getServer(opts.serverId);
  if (!server) throw new Error("Server not found");
  const input = {
    server,
    volumeId: opts.volumeId,
    hostPath: opts.hostMountPath,
    blockName: `app-${opts.appId}`,
  };
  if (testRemove) await testRemove(input);
  else await requireStorageDriver(opts.driverId).removeMount(input);
}

/** Best-effort teardown of a host bind mount (never throws). */
export async function removeBindMountBestEffort(opts: {
  serverId: number;
  driverId: string;
  volumeId: string;
  hostMountPath: string;
  appId: number;
}): Promise<void> {
  try {
    await removeBindMount(opts);
  } catch {
    /* best-effort */
  }
}
