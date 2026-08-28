import * as db from "../shared/db.ts";
import { hetzner } from "../shared/providers/index.ts";
import { isNotFoundError } from "../shared/providers/errors.ts";
import { ensureNetwork as ensureSharedNetwork } from "./network.ts";
import { bindMountStatus, ensureVolumeBindMount } from "./hetzner/host-mounts.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";
import { isManagedHetznerServer, serverCapabilities } from "../shared/infrastructure.ts";
import { secretStore } from "../shared/secret-store.ts";

function log(context: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [infra-reconciler:${context}]`, ...args);
}

async function withLock(keys: string[], kind: string, work: () => Promise<void>): Promise<void> {
  const lock = tryAcquire(keys, NON_OP_HOLDER, kind);
  if (!lock.ok) return;
  try { await work(); } finally { release(keys); }
}

function serverHasReferences(serverId: number): boolean {
  if (db.getReplicasByServer(serverId).length > 0) return true;
  if (db.getServiceInstancesByServer(serverId).length > 0) return true;
  if (db.getPanel()?.server_id === serverId) return true;
  if (db.getGitHubRunnerByServerId(serverId)) return true;
  return db.getApps().some((app) => app.sleeping_server_id === serverId);
}

/** Observe provider truth, repair private-network attachment, and make a
 * confirmed missing server unavailable to schedulers and routing. */
export async function reconcileServersAndNetwork(): Promise<void> {
  const managedServers = db.getServers().filter((server) => isManagedHetznerServer(server) && server.provider_id);
  if (managedServers.length === 0) return;
  if (!await secretStore.get(hetzner.tokenKey).catch(() => null)) return;
  let networkId = "";
  if (hetzner.networks) {
    try {
      networkId = await ensureSharedNetwork();
    } catch (error) {
      // Server liveness is independent of private-network control-plane
      // health. Keep observing provider truth even when network repair is
      // temporarily unavailable.
      log("network", `shared network reconciliation failed: ${error}`);
    }
  }
  for (const snapshot of managedServers) {
    await withLock([`server:${snapshot.id}`], "reconcile:server", async () => {
      const server = db.getServer(snapshot.id);
      if (!server) return;
      try {
        const observed = await hetzner.getServer(server.provider_id);
        const available = observed.status === "running";
        db.recordServerObservation(server.id, {
          providerStatus: observed.status,
          ipv4: observed.ipv4 || undefined,
          ipv6: observed.ipv6 || undefined,
          available,
        });
        const fresh = db.getServer(server.id);
        if (available && fresh?.status === "unavailable") db.updateServerStatus(server.id, "ready");
        if (!available && (fresh?.unavailable_ticks ?? 0) >= 2) {
          db.updateServerStatus(server.id, "unavailable");
          for (const replica of db.getReplicasByServer(server.id)) db.updateReplicaStatus(replica.id, "unhealthy");
          for (const instance of db.getServiceInstancesByServer(server.id)) db.updateServiceInstanceStatus(instance.id, "unhealthy");
        }
        if (!networkId || !hetzner.networks) return;
        try {
          let privateIpv4 = await hetzner.networks.getPrivateIpv4(server.provider_id, networkId);
          if (!privateIpv4) {
            // The provider authoritatively reports detachment. Stop routing to
            // the cached address before attempting repair.
            db.updateServer(server.id, { private_ipv4: "" });
            await hetzner.networks.attachServer(server.provider_id, networkId);
            privateIpv4 = await hetzner.networks.getPrivateIpv4(server.provider_id, networkId);
          }
          if (privateIpv4) db.updateServer(server.id, { private_ipv4: privateIpv4 });
        } catch (networkError) {
          log("network", `${server.name}: attachment reconciliation failed: ${networkError}`);
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          log("server", `${server.name}: observation failed: ${error}`);
          return;
        }
        db.recordServerObservation(server.id, { providerStatus: "missing", available: false });
        const fresh = db.getServer(server.id);
        if ((fresh?.unavailable_ticks ?? 0) >= 2) {
          db.updateServerStatus(server.id, "unavailable");
          for (const replica of db.getReplicasByServer(server.id)) db.updateReplicaStatus(replica.id, "unhealthy");
          for (const instance of db.getServiceInstancesByServer(server.id)) db.updateServiceInstanceStatus(instance.id, "unhealthy");
        }
      }
    });
  }
}

/** Continuously reassert both firewall rules and server attachments. */
export async function reconcileFirewall(): Promise<void> {
  const servers = db.getServers().filter((server) =>
    isManagedHetznerServer(server) && server.provider_id && server.status !== "cleanup_failed"
  );
  if (servers.length === 0) return;
  if (!await secretStore.get(hetzner.tokenKey).catch(() => null)) return;
  const firewallId = await hetzner.ensureFirewall();
  await Promise.all(servers.map(async (server) => {
    try {
      await withLock(
        [`server:${server.id}`],
        "reconcile:firewall",
        () => hetzner.ensureFirewallAttached(firewallId, server.provider_id),
      );
    } catch (error) {
      log("firewall", `${server.name}: attachment reconciliation failed: ${error}`);
    }
  }));
}

/** Finish requested server GC only after a complete reference recheck and a
 * successful/idempotent provider deletion. */
export async function reconcileServerGc(
  provider: Pick<typeof hetzner, "deleteServer"> = hetzner,
): Promise<void> {
  for (const snapshot of db.getServers().filter((server) => !!server.gc_requested_at)) {
    await withLock([`server:${snapshot.id}`], "reconcile:server-gc", async () => {
      const server = db.getServer(snapshot.id);
      if (!server) return;
      if (serverHasReferences(server.id)) {
        db.clearServerGcRequest(server.id);
        return;
      }
      try {
        if (isManagedHetznerServer(server) && server.provider_id) {
          if (provider === hetzner && !await secretStore.get(hetzner.tokenKey).catch(() => null)) return;
          await provider.deleteServer(server.provider_id);
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          log("gc", `${server.name}: provider deletion failed: ${error}`);
          return;
        }
      }
      db.deleteServer(server.id);
      log("gc", `${server.name}: provider and DB rows removed`);
    });
  }
}

type VolumeOwner = {
  key: string;
  volumeId: string;
  serverId: number;
  hostMountPath: string;
  blockName: string;
  markDegraded: (reason: string) => void;
};

function activeVolumeOwners(): VolumeOwner[] {
  const owners: VolumeOwner[] = [];
  for (const app of db.getApps()) {
    const replicas = db.getReplicas(app.id);
    const replica = replicas.find((candidate) =>
      candidate.status === "running" && db.getServer(candidate.server_id)?.status === "ready"
    ) ?? replicas.find((candidate) => db.getServer(candidate.server_id)?.status === "ready") ?? replicas[0];
    if (!app.volume_id || !app.volume_mount || !replica || app.deletion_requested_at) continue;
    owners.push({
      key: `app:${app.id}`,
      volumeId: app.volume_id,
      serverId: replica.server_id,
      hostMountPath: app.volume_mount.split(":")[0],
      blockName: `app-${app.id}`,
      markDegraded: (reason) => {
        const wasUnhealthy = db.getApp(app.id)?.status === "unhealthy";
        db.updateAppStatus(app.id, "unhealthy");
        if (!wasUnhealthy) db.appendDeployLog(app.id, `[volume] ${reason}`);
      },
    });
  }
  for (const service of db.getServices()) {
    if (service.deletion_requested_at) continue;
    for (const instance of db.getServiceInstances(service.id)) {
      if (!instance.volume_id || !instance.volume_mount) continue;
      owners.push({
        key: `service:${service.id}`,
        volumeId: instance.volume_id,
        serverId: instance.server_id,
        hostMountPath: instance.volume_mount.split(":")[0],
        blockName: `svc-${service.id}`,
        markDegraded: (reason) => {
          db.updateServiceInstanceStatus(instance.id, "unhealthy");
          db.updateServiceStatus(service.id, "unhealthy");
          log("volume", `${service.name}: ${reason}`);
        },
      });
    }
  }
  const panel = db.getPanel();
  if (panel?.volume_id && panel.volume_mount) {
    owners.push({
      key: `server:${panel.server_id}`,
      volumeId: panel.volume_id,
      serverId: panel.server_id,
      hostMountPath: panel.volume_mount.split(":")[0],
      blockName: "panel",
      markDegraded: (reason) => log("volume", `panel: ${reason}`),
    });
  }
  return owners;
}

/** Repair unambiguous active-volume drift. A detached desired volume may be
 * reattached to its recorded host; a volume attached elsewhere is never moved
 * automatically and is surfaced as degraded instead. */
export async function reconcileActiveVolumes(): Promise<void> {
  if (!await secretStore.get(hetzner.tokenKey).catch(() => null)) return;
  for (const owner of activeVolumeOwners()) {
    const keys = [owner.key, `server:${owner.serverId}`, `volume:${owner.volumeId}`];
    try {
      await withLock([...new Set(keys)], "reconcile:volume", async () => {
        const server = db.getServer(owner.serverId);
        if (!server?.provider_id || server.status !== "ready" || !serverCapabilities(server).providerVolumes) return;
        let volume;
        try {
          volume = await hetzner.volumes.get(owner.volumeId);
        } catch (error) {
          owner.markDegraded(
            isNotFoundError(error)
              ? `volume ${owner.volumeId} is missing`
              : `volume inspection failed: ${error}`,
          );
          return;
        }
        if (volume.serverId && volume.serverId !== server.provider_id) {
          owner.markDegraded(`volume ${owner.volumeId} is attached to unexpected server ${volume.serverId}`);
          return;
        }
        if (!volume.serverId) await hetzner.volumes.attach(owner.volumeId, server.provider_id);
        const status = await bindMountStatus({
          serverIp: server.ipv4,
          hostKey: server.ssh_host_key || undefined,
          hostMountPath: owner.hostMountPath,
          expectedVolumeId: owner.volumeId,
          blockName: owner.blockName,
        });
        if (
          !status.mounted || !status.fstabPresent ||
          !status.matchesExpectedVolume
        ) {
          await ensureVolumeBindMount({
            serverIp: server.ipv4,
            hostKey: server.ssh_host_key || undefined,
            hetznerVolumeId: owner.volumeId,
            hostMountPath: owner.hostMountPath,
            blockName: owner.blockName,
            mountWaitMs: 15_000,
          });
        }
      });
    } catch (error) {
      owner.markDegraded(`volume reconciliation failed: ${error}`);
    }
  }
}
