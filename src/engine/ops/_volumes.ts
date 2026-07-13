import * as db from "../../shared/db.ts";
import {
  ensureVolumeBindMount as realEnsure,
  removeVolumeBindMount as realRemove,
} from "../hetzner/host-mounts.ts";

let _ensureVolumeBindMount = realEnsure;
let _removeVolumeBindMount = realRemove;
/** Test-only seam. */
export function __setBindImplForTest(impl: { ensureVolumeBindMount?: typeof realEnsure; removeVolumeBindMount?: typeof realRemove }) {
  if (impl.ensureVolumeBindMount) _ensureVolumeBindMount = impl.ensureVolumeBindMount;
  if (impl.removeVolumeBindMount) _removeVolumeBindMount = impl.removeVolumeBindMount;
}
export function __resetBindImplForTest() { _ensureVolumeBindMount = realEnsure; _removeVolumeBindMount = realRemove; }

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
 * Set up the host bind mount for a volume. On Hetzner we wait for the automount
 * to settle then layer the fstab-persisted bind (mirrors the routes' 3s sleep +
 * ensureVolumeBindMount). On other providers we just create the mount dir.
 * Idempotent: safe to replay after a crash.
 */
export async function ensureBindMount(opts: {
  serverIp: string;
  hostKey: string;
  volumeId: string;
  hostMountPath: string;
  appId: number;
}): Promise<void> {
  await Bun.sleep(3000);
  await _ensureVolumeBindMount({
    serverIp: opts.serverIp,
    hostKey: opts.hostKey || undefined,
    hetznerVolumeId: opts.volumeId,
    hostMountPath: opts.hostMountPath,
    blockName: `app-${opts.appId}`,
  });
}

/** Best-effort teardown of a host bind mount (Hetzner only; never throws). */
export async function removeBindMountBestEffort(opts: {
  serverIp: string;
  hostKey: string;
  hostMountPath: string;
  appId: number;
}): Promise<void> {
  try {
    await _removeVolumeBindMount({
      serverIp: opts.serverIp,
      hostKey: opts.hostKey || undefined,
      hostMountPath: opts.hostMountPath,
      blockName: `app-${opts.appId}`,
    });
  } catch {
    /* best-effort */
  }
}
