import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { type ProgressFn } from "./types.ts";

export async function pickTargetServer(
  app: any,
  settings: Record<string, string>,
  emit: ProgressFn,
  preferredServerId?: number
): Promise<any> {
  // Explicit placement: caller chose a specific server
  if (preferredServerId) {
    const preferred = db.getServer(preferredServerId);
    if (!preferred) throw new Error(`Target server ${preferredServerId} not found`);
    if (preferred.status !== "ready") throw new Error(`Target server ${preferred.name} is not ready (status: ${preferred.status})`);
    emit("scale", `Placing replica on ${preferred.name} (user-selected)`);
    return preferred;
  }

  // Find servers with fewest replicas of this app
  const allServers = db.getServers();
  const appReplicas = db.getReplicas(app.id);
  const replicasByServer = new Map<number, number>();
  for (const r of appReplicas) {
    replicasByServer.set(r.server_id, (replicasByServer.get(r.server_id) || 0) + 1);
  }

  // Find server with fewest replicas (prefer existing servers with 0 replicas of this app)
  let bestServer: any = null;
  let bestCount = Infinity;
  for (const server of allServers) {
    if (server.status !== "ready") continue;
    const count = replicasByServer.get(server.id) || 0;
    if (count < bestCount) {
      bestCount = count;
      bestServer = server;
    }
  }

  // If no server has room, or all servers already have replicas, provision new
  if (!bestServer || bestCount > 0) {
    emit("scale", "Provisioning new server for replica...");

    const [sshKey, firewallId] = await Promise.all([
      hetzner.ensureSshKey("one-click-deploy"),
      hetzner.ensureFirewall(),
    ]);

    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    // Default location: any existing replica's server, else configured default.
    const replicas = db.getReplicas(app.id);
    const anyReplicaServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
    const location = anyReplicaServer?.location || settings.default_location;
    const serverName = `ocd-${app.name}-r${Date.now()}`;

    const hServer = await hetzner.createServer({
      name: serverName,
      server_type: serverType,
      location,
      ssh_key_name: sshKey.name,
      firewall_id: firewallId,
    });

    const serverIp = hServer.public_net.ipv4.ip;
    const dbServer = db.insertServer({
      name: serverName,
      hetzner_id: String(hServer.id),
      ipv4: serverIp,
      ipv6: hServer.public_net.ipv6.ip || "",
      type: serverType,
      location,
      status: "provisioning",
    });

    emit("scale", `Waiting for server ${serverName}...`);
    await hetzner.waitForServer(serverIp, 30, (msg) => emit("scale", msg));

    const hostKey = await hetzner.captureHostKey(serverIp);
    if (hostKey) {
      db.updateServerHostKey(dbServer.id, hostKey);
    }

    db.updateServerStatus(dbServer.id, "ready");
    emit("scale", `Server ${serverName} ready`);
    return db.getServer(dbServer.id);
  }

  return bestServer;
}
