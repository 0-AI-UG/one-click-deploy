import * as db from "../db.ts";
import { getComputeProvider } from "../providers/index.ts";
import {
  sshExec, waitForServer, captureHostKey, getOrCreateLocalKeyPair,
} from "../remote/index.ts";
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

  onProgress("server", "Creating new server...");

  const compute = getComputeProvider();

  log("ssh", "Ensuring SSH key and firewall exist...");
  const { publicKey } = await getOrCreateLocalKeyPair();
  const [sshKey, firewallId] = await Promise.all([
    compute.ensureSshKey("one-click-deploy", publicKey),
    compute.ensureFirewall(),
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
    provider_id: "",
    provider: compute.id,
    ipv4: "",
    ipv6: "",
    type: serverType,
    location,
    status: "creating",
  });
  const serverId = dbServer.id;
  state.dbServerId = dbServer.id;

  log("server", `Creating server: name=${serverName} type=${serverType} location=${location}`);
  const createStart = Date.now();
  const providerServer = await compute.createServer({
    name: serverName,
    serverType,
    location,
    sshKeyName: sshKey.name,
    firewallId,
    userData: "",
  });
  state.providerServerId = providerServer.providerId;
  log("server", `Server created in ${Date.now() - createStart}ms: id=${providerServer.providerId}`);

  const serverIp = providerServer.ipv4;
  db.updateServer(dbServer.id, {
    provider_id: providerServer.providerId,
    ipv4: serverIp,
    ipv6: providerServer.ipv6 || "",
    status: "provisioning",
  });
  log("server", `Server saved to DB: id=${dbServer.id}`);
  onProgress("server", `Server created: ${serverName} (${serverIp})`);

  onProgress("provision", "Waiting for server to boot...");
  await compute.waitForRunning(providerServer.providerId, (msg) => {
    onProgress("provision", msg);
  });

  onProgress("provision", "Waiting for server to be ready...");
  log("provision", `Waiting for server ${serverIp} to be provisioned...`);
  const provisionStart = Date.now();
  await waitForServer(serverIp, 30, (msg) => {
    onProgress("provision", msg);
  });
  log("provision", `Server provisioned in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`);

  const dockerCheck = await sshExec(serverIp, "docker --version");
  if (dockerCheck.exitCode !== 0) {
    const initLog = await sshExec(serverIp, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
    log("provision", `Docker not found. Cloud-init log:\n${initLog.stdout}`);
    throw new Error("Server provisioned but Docker was not installed — server setup may have failed. Try deleting the server and deploying again.");
  }
  log("provision", `Docker verified: ${dockerCheck.stdout.trim()}`);

  const serverHostKey = await captureHostKey(serverIp);
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
  providerServerId: string | undefined,
  serverIp: string,
  serverHostKey: string,
  defaultLocation: string | undefined,
  state: DeployState,
  onProgress: ProgressFn,
): Promise<string | undefined> {
  const compute = getComputeProvider();
  if (!compute.volumes) throw new Error("Compute provider does not support volumes");

  let resolvedProviderId: string;
  if (providerServerId) {
    resolvedProviderId = providerServerId;
  } else {
    const existingServer = db.getServer(serverId);
    if (!existingServer) throw new Error(`Server ${serverId} not found`);
    resolvedProviderId = existingServer.provider_id;
  }

  onProgress("build", `Creating ${volumeSize}GB persistent volume...`);
  const vol = await compute.volumes.create({
    name: `ocd-${appName}-data`,
    sizeGb: volumeSize,
    serverId: resolvedProviderId,
    location: defaultLocation || "nbg1",
  });
  state.volumeId = vol.providerId;
  const hostMountPath = `/mnt/ocd-${appName}-data`;
  const containerPath = volumePath || "/data";
  await sshExec(serverIp, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, serverHostKey || undefined);
  const volumeMount = `${hostMountPath}:${containerPath}`;
  log("build", `Volume mounted: ${volumeMount}`);
  onProgress("build", `Volume ready (${volumeSize}GB at /data)`);
  return volumeMount;
}
