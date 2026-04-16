import * as db from "../shared/db.ts";
import { getComputeProvider } from "../shared/providers/index.ts";
import { getOrCreateLocalKeyPair, waitForServer, captureHostKey } from "../shared/remote/index.ts";
import { sshExec } from "../shared/remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "./network.ts";
import type { ProgressFn, Server } from "./scale/types.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [provision:${context}]`, ...args);
}

/**
 * Provision a new server from scratch: create at the cloud provider, wait for
 * boot + cloud-init, verify Docker, capture host key, mark ready in DB.
 *
 * Shared by initial deploy, scale-up server creation, and manual server creation.
 */
export async function provisionServer(opts: {
  serverType: string;
  location: string;
  name?: string;
  emit: ProgressFn;
  orgId?: string;
}): Promise<Server> {
  const { serverType, location, emit, orgId = "" } = opts;
  const compute = getComputeProvider();
  const serverName = opts.name || `ocd-server-${Date.now()}`;

  emit("server", `Creating new ${compute.name} server...`);

  log("ssh", "Ensuring SSH key, firewall, and private network exist...");
  const { publicKey } = await getOrCreateLocalKeyPair();
  const [sshKey, firewallId, networkId] = await Promise.all([
    compute.ensureSshKey("one-click-deploy", publicKey),
    compute.ensureFirewall(),
    ensureSharedNetwork(),
  ]);
  log("ssh", `SSH key ready: ${sshKey.name}, firewall: ${firewallId}, network: ${networkId || "(none)"}`);
  emit("server", "SSH key + firewall + network ready");

  // Insert placeholder DB record BEFORE provider API call to prevent orphans
  const dbServer = db.insertServer({
    name: serverName,
    provider_id: "",
    provider: compute.id,
    ipv4: "",
    ipv6: "",
    type: serverType,
    location,
    status: "creating",
    org_id: orgId,
  });

  log("server", `Creating ${compute.name} server: name=${serverName} type=${serverType} location=${location}`);
  const createStart = Date.now();
  const providerServer = await compute.createServer({
    name: serverName,
    serverType,
    location,
    sshKeyName: sshKey.name,
    firewallId,
    networkId: networkId || undefined,
    userData: "",
  });
  log("server", `Server created in ${Date.now() - createStart}ms: id=${providerServer.providerId} private=${providerServer.privateIpv4 || "(none)"}`);

  // Update placeholder with real data
  const serverIp = providerServer.ipv4;
  db.updateServer(dbServer.id, {
    provider_id: providerServer.providerId,
    ipv4: serverIp,
    ipv6: providerServer.ipv6 || "",
    private_ipv4: providerServer.privateIpv4 || "",
    status: "provisioning",
  });
  log("server", `Server saved to DB: id=${dbServer.id}`);
  emit("server", `Server created: ${serverName} (${serverIp})`);

  // Wait for server VM to boot before attempting SSH
  emit("provision", "Waiting for server to boot...");
  await compute.waitForRunning(providerServer.providerId, (msg) => {
    emit("provision", msg);
  });

  // Wait for cloud-init provisioning
  emit("provision", "Waiting for server to be ready...");
  log("provision", `Waiting for server ${serverIp} to be provisioned...`);
  const provisionStart = Date.now();
  await waitForServer(serverIp, 30, (msg) => {
    emit("provision", msg);
  });
  log("provision", `Server provisioned in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`);

  // Verify docker is actually installed
  const dockerCheck = await sshExec(serverIp, "docker --version");
  if (dockerCheck.exitCode !== 0) {
    const initLog = await sshExec(serverIp, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
    log("provision", `Docker not found. Cloud-init log:\n${initLog.stdout}`);
    throw new Error("Server provisioned but Docker was not installed — server setup may have failed. Try deleting the server and deploying again.");
  }
  log("provision", `Docker verified: ${dockerCheck.stdout.trim()}`);

  // Capture SSH host key for future verification
  const hostKey = await captureHostKey(serverIp);
  if (hostKey) {
    db.updateServerHostKey(dbServer.id, hostKey);
    log("provision", "SSH host key captured and stored");
  }

  db.updateServerStatus(dbServer.id, "ready");
  emit("provision", `Server ${serverName} ready`);

  return db.getServer(dbServer.id) as Server;
}
