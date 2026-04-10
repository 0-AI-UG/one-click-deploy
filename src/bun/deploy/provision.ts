import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import type { DeployState } from "./rollback.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export type ServerInfo = {
  serverId: number;
  serverIp: string;
  serverHostKey: string;
};

export async function provisionOrReuseServer(
  appName: string,
  settings: { default_server_type?: string; default_location?: string },
  state: DeployState,
  onProgress: ProgressFn,
): Promise<ServerInfo> {
  const existingReady = db.getServers().find((s: any) => s.status === "ready");
  if (existingReady) {
    const serverIp = existingReady.ipv4;
    const serverHostKey = existingReady.ssh_host_key || "";
    const serverId = existingReady.id;
    state.dbServerId = existingReady.id;
    log("server", `Reusing existing ready server: ${existingReady.name} ip=${serverIp}`);
    onProgress("server", `Using server ${existingReady.name} (${serverIp})`);
    return { serverId, serverIp, serverHostKey };
  }

  onProgress("server", "Creating new Hetzner server...");

  log("ssh", "Ensuring SSH key and firewall exist...");
  const [sshKey, firewallId] = await Promise.all([
    hetzner.ensureSshKey("one-click-deploy"),
    hetzner.ensureFirewall(),
  ]);
  log("ssh", `SSH key ready: ${sshKey.name}, firewall: ${firewallId}`);
  onProgress("server", `SSH key + firewall ready`);

  const serverType = settings.default_server_type;
  if (!serverType) throw new Error("No default server type configured — set one in Settings");
  const location = settings.default_location;
  if (!location) throw new Error("No default server location configured — set one in Settings");
  const serverName = `ocd-${appName}-${Date.now()}`;

  const dbServer = db.insertServer({
    name: serverName,
    hetzner_id: "",
    ipv4: "",
    ipv6: "",
    type: serverType,
    location,
    status: "creating",
  });
  const serverId = dbServer.id;
  state.dbServerId = dbServer.id;

  log("server", `Creating Hetzner server: name=${serverName} type=${serverType} location=${location}`);
  const createStart = Date.now();
  const hServer = await hetzner.createServer({
    name: serverName,
    server_type: serverType,
    location,
    ssh_key_name: sshKey.name,
    firewall_id: firewallId,
  });
  state.hetznerServerId = String(hServer.id);
  log("server", `Hetzner server created in ${Date.now() - createStart}ms: id=${hServer.id}`);

  const serverIp = hServer.public_net.ipv4.ip;
  db.updateServer(dbServer.id, {
    hetzner_id: String(hServer.id),
    ipv4: serverIp,
    ipv6: hServer.public_net.ipv6.ip || "",
    status: "provisioning",
  });
  log("server", `Server saved to DB: id=${dbServer.id}`);
  onProgress("server", `Server created: ${serverName} (${serverIp})`);

  onProgress("provision", "Waiting for server to boot...");
  await hetzner.waitForServerRunning(hServer.id, (msg) => {
    onProgress("provision", msg);
  });

  onProgress("provision", "Waiting for server to be ready...");
  log("provision", `Waiting for server ${serverIp} to be provisioned...`);
  const provisionStart = Date.now();
  await hetzner.waitForServer(serverIp, 30, (msg) => {
    onProgress("provision", msg);
  });
  log("provision", `Server provisioned in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`);

  const dockerCheck = await hetzner.sshExec(serverIp, "docker --version");
  if (dockerCheck.exitCode !== 0) {
    const initLog = await hetzner.sshExec(serverIp, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
    log("provision", `Docker not found. Cloud-init log:\n${initLog.stdout}`);
    throw new Error("Server provisioned but Docker was not installed — server setup may have failed. Try deleting the server and deploying again.");
  }
  log("provision", `Docker verified: ${dockerCheck.stdout.trim()}`);

  const serverHostKey = await hetzner.captureHostKey(serverIp);
  if (serverHostKey) {
    db.updateServerHostKey(dbServer.id, serverHostKey);
    log("provision", "SSH host key captured and stored");
  }

  db.updateServerStatus(dbServer.id, "ready");
  onProgress("provision", "Server provisioned with Docker + Caddy");

  return { serverId, serverIp, serverHostKey };
}

export async function createVolume(
  appName: string,
  volumeSize: number,
  volumePath: string | undefined,
  serverId: number,
  hetznerServerId: string | undefined,
  serverIp: string,
  serverHostKey: string,
  defaultLocation: string | undefined,
  state: DeployState,
  onProgress: ProgressFn,
): Promise<string | undefined> {
  let resolvedHetznerServerId: number;
  if (hetznerServerId) {
    resolvedHetznerServerId = parseInt(hetznerServerId, 10);
  } else {
    const existingServer = db.getServer(serverId);
    if (!existingServer) throw new Error(`Server ${serverId} not found`);
    resolvedHetznerServerId = parseInt(existingServer.hetzner_id, 10);
  }

  onProgress("build", `Creating ${volumeSize}GB persistent volume...`);
  const vol = await hetzner.createVolume({
    name: `ocd-${appName}-data`,
    size: volumeSize,
    server_id: resolvedHetznerServerId,
    location: defaultLocation || "nbg1",
  });
  state.volumeId = String(vol.id);
  const hostMountPath = `/mnt/ocd-${appName}-data`;
  const containerPath = volumePath || "/data";
  await hetzner.sshExec(serverIp, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, serverHostKey || undefined);
  const volumeMount = `${hostMountPath}:${containerPath}`;
  log("build", `Volume mounted: ${volumeMount}`);
  onProgress("build", `Volume ready (${volumeSize}GB at /data)`);
  return volumeMount;
}
