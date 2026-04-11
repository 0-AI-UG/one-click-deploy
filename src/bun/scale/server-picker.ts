import * as db from "../db.ts";
import { getComputeProvider } from "../providers/index.ts";
import { getOrCreateLocalKeyPair, waitForServer, captureHostKey } from "../remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { type ProgressFn, type App, type Server } from "./types.ts";

export async function pickTargetServer(
  app: App,
  settings: Record<string, string>,
  emit: ProgressFn,
  preferredServerId?: number
): Promise<Server> {
  // Explicit placement: caller chose a specific server
  if (preferredServerId) {
    const preferred = db.getServer(preferredServerId) as Server | null;
    if (!preferred) throw new Error(`Target server ${preferredServerId} not found`);
    if (preferred.status !== "ready") throw new Error(`Target server ${preferred.name} is not ready (status: ${preferred.status})`);
    emit("scale", `Placing replica on ${preferred.name} (user-selected)`);
    return preferred;
  }

  // Find servers with fewest replicas of this app
  const allServers = db.getServers() as Server[];
  const appReplicas = db.getReplicas(app.id) as { server_id: number }[];
  const replicasByServer = new Map<number, number>();
  for (const r of appReplicas) {
    replicasByServer.set(r.server_id, (replicasByServer.get(r.server_id) || 0) + 1);
  }

  // Find server with fewest replicas (prefer existing servers with 0 replicas
  // of this app).
  let bestServer: Server | null = null;
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

    const compute = getComputeProvider();
    const { publicKey } = await getOrCreateLocalKeyPair();
    const [sshKey, firewallId, networkId] = await Promise.all([
      compute.ensureSshKey("one-click-deploy", publicKey),
      compute.ensureFirewall(),
      ensureSharedNetwork(),
    ]);

    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    // Default location: any existing replica's server, else configured default.
    const replicas = db.getReplicas(app.id);
    const anyReplicaServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
    const location = anyReplicaServer?.location || settings.default_location;
    const serverName = `ocd-${app.name}-r${Date.now()}`;

    const hServer = await compute.createServer({
      name: serverName,
      serverType,
      location,
      sshKeyName: sshKey.name,
      firewallId,
      networkId: networkId || undefined,
      userData: "",
    });

    const serverIp = hServer.ipv4;
    const dbServer = db.insertServer({
      name: serverName,
      provider_id: hServer.providerId,
      provider: compute.id,
      ipv4: serverIp,
      ipv6: hServer.ipv6 || "",
      type: serverType,
      location,
      status: "provisioning",
      private_ipv4: hServer.privateIpv4 || "",
    });

    emit("scale", `Waiting for server ${serverName}...`);
    await waitForServer(serverIp, 30, (msg) => emit("scale", msg));

    const hostKey = await captureHostKey(serverIp);
    if (hostKey) {
      db.updateServerHostKey(dbServer.id, hostKey);
    }

    db.updateServerStatus(dbServer.id, "ready");
    emit("scale", `Server ${serverName} ready`);
    return db.getServer(dbServer.id) as Server;
  }

  return bestServer;
}
