import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import {
  getOrCreateLocalKeyPair,
  waitForServer,
  captureHostKey,
  sshExec,
} from "../../shared/remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";
import { registerOp } from "./registry.ts";
import { FatalProbeError, type OpKindDefinition, type Step } from "../types.ts";

type ProvisionInput = {
  serverType: string;
  location: string;
  name?: string;
  pool?: string;
};

type EnsureInfraOut = {
  sshKeyName: string;
  firewallId: string;
  networkId: string | null;
};

type InsertRowOut = { serverId: number; serverName: string };

type CreateCloudOut = {
  providerId: string;
  ipv4: string;
  ipv6: string;
  privateIpv4: string;
};

function operationServerName(input: ProvisionInput, opId: number): string {
  return input.name || `ocd-server-op${opId}`;
}

async function adoptCloudServerByName(
  row: InsertRowOut,
): Promise<CreateCloudOut | null> {
  const existing = (await hetzner.listServers()).find((server) => server.name === row.serverName);
  if (!existing) return null;
  const detailed = await hetzner.getServer(existing.providerId);
  const adopted = {
    providerId: detailed.providerId,
    ipv4: detailed.ipv4,
    ipv6: detailed.ipv6 || "",
    privateIpv4: detailed.privateIpv4 || "",
  };
  db.updateServer(row.serverId, {
    provider_id: adopted.providerId,
    ipv4: adopted.ipv4,
    ipv6: adopted.ipv6,
    private_ipv4: adopted.privateIpv4,
    status: "provisioning",
    management_address: adopted.ipv4,
  });
  return adopted;
}

const ensureInfra: Step<ProvisionInput, EnsureInfraOut> = {
  name: "ensure_infra",
  label: "Ensure SSH key, firewall, network",
  async run(ctx) {
    const compute = hetzner;
    const { publicKey } = await getOrCreateLocalKeyPair();
    const [sshKey, firewallId, networkId] = await Promise.all([
      compute.ensureSshKey("open-cli-deployment", publicKey),
      compute.ensureFirewall(),
      ensureSharedNetwork(),
    ]);
    ctx.log(`SSH key ${sshKey.name}, firewall ${firewallId}, network ${networkId || "(none)"}`);
    return {
      sshKeyName: sshKey.name,
      firewallId,
      networkId: networkId || null,
    };
  },
  // No compensate — key/firewall/network are shared infra, reused across servers.
};

const insertServerRow: Step<ProvisionInput, InsertRowOut> = {
  name: "insert_server_row",
  label: "Register server",
  async run(ctx) {
    const serverName = operationServerName(ctx.input, ctx.opId);
    const existing = db.getServers().find((s) => s.name === serverName && s.status === "creating");
    if (existing) {
      // Idempotent replay: reuse the placeholder row.
      return { serverId: existing.id, serverName };
    }
    const row = db.insertServer({
      name: serverName,
      provider_id: "",
      ipv4: "",
      ipv6: "",
      type: ctx.input.serverType,
      location: ctx.input.location,
      status: "creating",
      provider: "hetzner",
      ownership: "managed",
      pool: ctx.input.pool || "general",
    });
    return { serverId: row.id, serverName };
  },
  async compensate(ctx, out) {
    if (!out) return;
    // Delete of an already-gone row is a no-op (so retry is safe); let a
    // genuine failure PROPAGATE rather than orphan the placeholder server row
    // behind a clean `compensated`.
    db.deleteServer(out.serverId);
  },
};

const createCloudServer: Step<ProvisionInput, CreateCloudOut> = {
  name: "create_cloud_server",
  label: "Create cloud server",
  async probe(_ctx, prior) {
    const row = prior["insert_server_row"] as InsertRowOut;
    const current = db.getServer(row.serverId);
    if (current?.provider_id) {
      return {
        providerId: current.provider_id,
        ipv4: current.ipv4,
        ipv6: current.ipv6,
        privateIpv4: current.private_ipv4 || "",
      };
    }
    // When provider identity is unknown, creating another server is unsafe;
    // turn lookup failures into fatal probe errors rather than falling through
    // to create and risking a second billable server.
    try {
      return await adoptCloudServerByName(row);
    } catch (cause) {
      throw new FatalProbeError(
        `Could not determine whether provider server ${row.serverName} already exists`,
        { cause },
      );
    }
  },
  async run(ctx, prior) {
    const infra = prior["ensure_infra"] as EnsureInfraOut;
    const row = prior["insert_server_row"] as InsertRowOut;
    const compute = hetzner;

    // Idempotent replay: if the row already has a provider_id, read back.
    const current = db.getServer(row.serverId);
    if (current && current.provider_id) {
      return {
        providerId: current.provider_id,
        ipv4: current.ipv4,
        ipv6: current.ipv6,
        privateIpv4: current.private_ipv4 || "",
      };
    }

    // Defend direct callers as well as the step runner. The runner probes
    // before run, but a second lookup here closes the gap if a provider request
    // completed while the first lookup was in flight.
    const adopted = await adoptCloudServerByName(row);
    if (adopted) {
      ctx.log(`Adopted provider server ${row.serverName} (${adopted.ipv4})`);
      return adopted;
    }

    const created = await compute.createServer({
      name: row.serverName,
      serverType: ctx.input.serverType,
      location: ctx.input.location,
      sshKeyName: infra.sshKeyName,
      firewallId: infra.firewallId,
      networkId: infra.networkId || undefined,
      userData: "",
    });
    db.updateServer(row.serverId, {
      provider_id: created.providerId,
      ipv4: created.ipv4,
      ipv6: created.ipv6 || "",
      private_ipv4: created.privateIpv4 || "",
      status: "provisioning",
      management_address: created.ipv4,
    });
    ctx.log(`Server created: ${row.serverName} (${created.ipv4})`);
    return {
      providerId: created.providerId,
      ipv4: created.ipv4,
      ipv6: created.ipv6 || "",
      privateIpv4: created.privateIpv4 || "",
    };
  },
  async compensate(ctx, out) {
    if (!out?.providerId) return;
    // Deleting the cloud server is a real teardown — swallowing a failure would
    // leak a billable Hetzner server behind a clean `compensated`. Delete is
    // idempotent (an already-gone server is success), but any other failure
    // must PROPAGATE so it surfaces as `compensation_failed`.
    try {
      await hetzner.deleteServer(out.providerId);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  },
  async probeCompensated(_ctx, out) {
    if (!out?.providerId) return true;
    try {
      await hetzner.getServer(out.providerId);
      return false; // still exists — compensate must run
    } catch (err) {
      // Only a definitive not-found means "already deleted". A transient error
      // (5xx / rate-limit / network) must NOT skip the delete, or we'd leak the
      // server — fall through to run compensate, which tolerates not-found.
      return isNotFoundError(err);
    }
  },
};

const waitForBoot: Step<ProvisionInput, { ok: true }> = {
  name: "wait_for_boot",
  label: "Wait for boot",
  async run(ctx, prior) {
    const cloud = prior["create_cloud_server"] as CreateCloudOut;
    const compute = hetzner;
    await compute.waitForRunning(cloud.providerId, (msg) => ctx.log(msg));
    return { ok: true };
  },
};

const runCloudInit: Step<ProvisionInput, { ok: true }> = {
  name: "run_cloud_init",
  label: "Wait for cloud-init and verify Docker",
  async run(ctx, prior) {
    const cloud = prior["create_cloud_server"] as CreateCloudOut;
    await waitForServer(cloud.ipv4, 30, (msg) => ctx.log(msg));
    const dockerCheck = await sshExec(cloud.ipv4, "docker --version");
    if (dockerCheck.exitCode !== 0) {
      const initLog = await sshExec(cloud.ipv4, "tail -20 /var/log/cloud-init-deploy.log 2>/dev/null");
      ctx.log(`Docker not found. Cloud-init log:\n${initLog.stdout}`);
      throw new Error("Server provisioned but Docker was not installed — server setup may have failed.");
    }
    ctx.log(`Docker verified: ${dockerCheck.stdout.trim()}`);
    return { ok: true };
  },
};

const captureHostKeyStep: Step<ProvisionInput, { captured: boolean }> = {
  name: "capture_host_key",
  label: "Capture SSH host key",
  async run(ctx, prior) {
    const cloud = prior["create_cloud_server"] as CreateCloudOut;
    const row = prior["insert_server_row"] as InsertRowOut;
    const hostKey = await captureHostKey(cloud.ipv4);
    if (hostKey) {
      db.updateServerHostKey(row.serverId, hostKey);
      ctx.log("SSH host key stored");
      return { captured: true };
    }
    return { captured: false };
  },
};

const markReady: Step<ProvisionInput, { serverId: number }> = {
  name: "mark_ready",
  label: "Mark ready",
  async run(ctx, prior) {
    const row = prior["insert_server_row"] as InsertRowOut;
    db.updateServerStatus(row.serverId, "ready");
    ctx.log(`Server ${row.serverName} ready`);
    return { serverId: row.serverId };
  },
};

const provisionServerOp: OpKindDefinition<ProvisionInput> = {
  kind: "provision_server",
  label: "Provision server",
  resourceKeys: () => ["create-server"],
  steps: [
    ensureInfra,
    insertServerRow,
    createCloudServer,
    waitForBoot,
    runCloudInit,
    captureHostKeyStep,
    markReady,
  ],
};

registerOp(provisionServerOp as OpKindDefinition<any>);

export default provisionServerOp;
export type { ProvisionInput };
