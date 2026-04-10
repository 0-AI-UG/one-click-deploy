import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";

export type DeployState = {
  hetznerServerId?: string;
  dbServerId?: number;
  dbAppId?: number;
  dnsRecord?: { zone_id: string; name: string; type: string; value: string };
  containerName?: string;
  deployMode?: "dockerfile" | "compose";
  caddyConfigured?: boolean;
  caddyDomain?: string;
  volumeId?: string;
  replicaId?: number;
};

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function rollback(state: DeployState, serverIp: string, hostKey?: string): Promise<void> {
  log("rollback", "Rolling back deploy state:", state);

  if (state.caddyConfigured && state.caddyDomain && serverIp) {
    try {
      await hetzner.removeCaddySite(serverIp, state.caddyDomain, hostKey);
      log("rollback", "Removed Caddy site");
    } catch (err) {
      log("rollback", `Failed to remove Caddy site: ${err}`);
    }
  }

  if (state.containerName && serverIp) {
    try {
      if (state.deployMode === "compose") {
        await hetzner.removeCompose(serverIp, state.containerName, false, hostKey);
      } else {
        await hetzner.removeContainer(serverIp, state.containerName, hostKey);
      }
      log("rollback", `Removed container ${state.containerName}`);
    } catch (err) {
      log("rollback", `Failed to remove container: ${err}`);
    }
  }

  if (state.volumeId) {
    try {
      await hetzner.deleteVolume(state.volumeId);
      log("rollback", `Deleted volume ${state.volumeId}`);
    } catch (err) {
      log("rollback", `Failed to delete volume: ${err}`);
    }
  }

  if (state.dnsRecord) {
    try {
      await hetzner.deleteDnsRecord(state.dnsRecord);
      log("rollback", `Deleted DNS record ${state.dnsRecord.name}/${state.dnsRecord.type}`);
    } catch (err) {
      log("rollback", `Failed to delete DNS record: ${err}`);
    }
  }

  if (state.replicaId) {
    try { db.deleteReplica(state.replicaId); } catch (err) {
      log("rollback", `Failed to delete replica record: ${err}`);
    }
  }

  if (state.dbAppId) {
    try {
      db.deleteApp(state.dbAppId);
      log("rollback", `Deleted app record ${state.dbAppId}`);
    } catch (err) {
      log("rollback", `Failed to delete app record: ${err}`);
    }
  }

  if (state.dbServerId) {
    try {
      await db.gcServerIfEmpty(state.dbServerId);
    } catch (err) {
      log("rollback", `gcServerIfEmpty(${state.dbServerId}) failed: ${err}`);
    }
  }

  log("rollback", "Rollback complete");
}
