import * as db from "../shared/db.ts";
import { hetzner } from "../shared/providers/index.ts";
import { getOrCreateLocalKeyPair, waitForServer, captureHostKey, ensureHostLogPolicy } from "../shared/remote/index.ts";
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
  // Capacity pool the new server joins. Defaults to 'general'; a staging-pool
  // app's scale-up passes its placement_pool so the server lands in that pool.
  pool?: string;
  /** True only for a user-initiated operation whose capacity plan was approved
   * in the browser before it entered the engine. */
  approved: boolean;
  emit: ProgressFn;
}): Promise<Server> {
  const { serverType, location, emit } = opts;
  const compute = hetzner;
  const serverName = opts.name || `ocd-server-${Date.now()}`;

  if (!opts.approved) {
    throw new Error(
      "Automatic server creation requires browser approval. Run `ocd servers create` and approve the capacity in the web UI.",
    );
  }

  const existingRow = db.getServers().find((server) => server.name === serverName);
  if (existingRow) {
    if (
      existingRow.type !== serverType ||
      existingRow.location !== location ||
      existingRow.pool !== (opts.pool ?? "general")
    ) {
      throw new Error(
        `Server name collision for ${serverName}: the existing database row has different placement or type`,
      );
    }
    if (existingRow.status === "ready" && existingRow.provider_id && existingRow.ipv4) {
      emit("server", `Reusing ready server ${serverName}`);
      return existingRow as Server;
    }
  }

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

  // Insert the placeholder BEFORE the provider call, and reuse it on replay.
  // The row is the ownership marker that distinguishes safe crash-adoption
  // from an unrelated provider resource with the same name.
  const dbServer = existingRow ?? db.insertServer({
      name: serverName,
      provider_id: "",
      ipv4: "",
      ipv6: "",
      type: serverType,
      location,
      status: "creating",
      pool: opts.pool ?? "general",
    });

  log("server", `Creating ${compute.name} server: name=${serverName} type=${serverType} location=${location}`);
  let providerServer;
  if (dbServer.provider_id) {
    providerServer = await compute.getServer(dbServer.provider_id);
  } else {
    // A provider create may have succeeded immediately before a process crash.
    // Resolve the deterministic name before issuing another billable create.
    // Lookup failure is fatal: an inconclusive provider state is never a
    // licence to create a possible duplicate.
    const matching = (await compute.listServers()).find((server) => server.name === serverName);
    if (matching) {
      if (!existingRow) {
        // This invocation created the DB marker, so a pre-existing provider
        // server cannot belong to it.
        db.deleteServer(dbServer.id);
        throw new Error(
          `Provider server name collision for ${serverName}; refusing implicit adoption`,
        );
      }
      providerServer = await compute.getServer(matching.providerId);
      providerServer = {
        ...providerServer,
        ipv4: providerServer.ipv4 || matching.ipv4,
        ipv6: providerServer.ipv6 || matching.ipv6,
      };
      emit("server", `Adopted provider server ${serverName} after interrupted provisioning`);
    } else {
      const createStart = Date.now();
      providerServer = await compute.createServer({
        name: serverName,
        serverType,
        location,
        sshKeyName: sshKey.name,
        firewallId,
        networkId: networkId || undefined,
        userData: "",
      });
      log("server", `Server created in ${Date.now() - createStart}ms: id=${providerServer.providerId} private=${providerServer.privateIpv4 || "(none)"}`);
    }
  }

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

  // Bound journal growth immediately; the reconciler also repairs this policy
  // periodically for hosts provisioned by older OCD releases.
  await ensureHostLogPolicy(serverIp, hostKey || undefined);

  db.updateServerStatus(dbServer.id, "ready");
  emit("provision", `Server ${serverName} ready`);

  return db.getServer(dbServer.id) as Server;
}
