import * as db from "../../shared/db.ts";
import {
  getContainerLogs,
  healthCheck,
  pullImmutableImageAndRun,
  removeContainer,
  sshExec,
} from "../../shared/remote/index.ts";
import { defaultStorageDriverForServer } from "../storage/index.ts";
import { deployTraefikPanelSite, installTraefikOn } from "../scale/traefik-manager.ts";
import { handoffDbToVolume } from "./self-deploy.ts";

export type ConnectedPanelHost = {
  name: string;
  managementAddress: string;
  routingAddress: string;
  sshHostKey: string;
};

export type ConnectedPanelOpts = {
  host: ConnectedPanelHost;
  appName: string;
  domain?: string;
  imageRef: string;
  containerPort: number;
  envVars: Record<string, string>;
  volumePath: string;
};

type ProgressFn = (step: string, detail: string) => void;

function reboundHostKey(hostKey: string, address: string): string {
  const [, algorithm, key, ...extra] = hostKey.trim().split(/\s+/);
  if (algorithm !== "ssh-ed25519" || !key || extra.length > 0 || key.length < 40 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error("ssh_host_key must be a complete Ed25519 ssh-keyscan line");
  }
  return `${address} ${algorithm} ${key}`;
}

/** Bootstrap OCD onto an operator-owned Docker host without a cloud API. */
export async function bootstrapPanelOnConnectedHost(
  opts: ConnectedPanelOpts,
  onProgress: ProgressFn,
): Promise<{ ok: boolean; error?: string; domain?: string; serverIp?: string; internalTls?: boolean; dnsResolved?: boolean }> {
  const { host } = opts;
  let serverId: number | undefined;
  let volumeId = "";
  let domain = opts.domain;
  let managementKey = "";
  try {
    if (db.getPanel()) throw new Error("Panel already bootstrapped in this DB");
    onProgress("server", `Verifying ${host.managementAddress}...`);
    if (!host.sshHostKey.startsWith(`${host.managementAddress} ssh-ed25519 `)) {
      throw new Error(`ssh_host_key must be pinned to management address ${host.managementAddress}`);
    }
    managementKey = reboundHostKey(host.sshHostKey, host.managementAddress);
    const preflight = await sshExec(
      host.managementAddress,
      "docker info --format '{{.ServerVersion}}' && hostname -I",
      managementKey,
    );
    if (preflight.exitCode !== 0) throw new Error(`SSH or Docker preflight failed: ${preflight.stderr.trim()}`);
    if (!preflight.stdout.split(/\s+/).includes(host.routingAddress)) {
      throw new Error(`Host does not own routing address ${host.routingAddress}`);
    }
    const routeKey = reboundHostKey(host.sshHostKey, host.routingAddress);
    const routeProbe = await sshExec(host.routingAddress, "true", routeKey);
    if (routeProbe.exitCode !== 0) throw new Error(`Panel bootstrap cannot reach routing address ${host.routingAddress}`);

    const server = db.insertServer({
      name: host.name,
      provider_id: "",
      provider: "",
      ownership: "connected",
      ipv4: host.managementAddress,
      ipv6: "",
      routing_address: host.routingAddress,
      management_address: host.managementAddress,
      ssh_user: "root",
      ssh_port: 22,
      type: "external",
      location: "external",
      status: "ready",
      pool: "general",
    });
    serverId = server.id;
    db.updateServerHostKey(server.id, managementKey);
    const readyServer = db.getServer(server.id)!;

    if (!domain) domain = `${host.managementAddress.replace(/\./g, "-")}.nip.io`;
    const storage = defaultStorageDriverForServer(readyServer);
    onProgress("storage", `Creating panel storage with ${storage.name}...`);
    const volume = await storage.create({ server: readyServer, name: `ocd-${opts.appName}-data`, sizeGb: 0 });
    volumeId = volume.id;
    await storage.ensureMount({ server: readyServer, volumeId, hostPath: volume.hostPath, blockName: "panel" });
    const volumeMount = `${volume.hostPath}:${opts.volumePath}`;

    db.insertPanel({
      server_id: server.id,
      name: opts.appName,
      domain,
      image_ref: opts.imageRef,
      container_port: opts.containerPort,
      host_port: 3001,
      volume_id: volumeId,
      volume_driver: storage.id,
      volume_mount: volumeMount,
      env_vars: JSON.stringify(opts.envVars),
      status: "running",
    });
    db.insertPanelDeployment({ image_tag: opts.imageRef, git_commit: "", status: "deployed", source: "connected-host-bootstrap" });

    onProgress("storage", "Handing off the bootstrap database...");
    await handoffDbToVolume({ serverIp: host.managementAddress, hostKey: managementKey, hostMountPath: volume.hostPath });
    onProgress("artifact", `Starting ${opts.imageRef}...`);
    await pullImmutableImageAndRun(host.managementAddress, {
      name: opts.appName,
      imageRef: opts.imageRef,
      port: opts.containerPort,
      hostPort: 3001,
      envVars: opts.envVars,
      volumeMount,
      hostKey: managementKey,
    }, (line) => onProgress("artifact", line));

    onProgress("ingress", `Configuring ingress for ${domain}...`);
    await installTraefikOn(host.managementAddress, managementKey);
    await deployTraefikPanelSite(host.managementAddress, domain, 3001, managementKey);
    const health = await healthCheck(host.managementAddress, opts.appName, "127.0.0.1", 3001, 5, managementKey);
    if (!health.healthy) {
      const logs = await getContainerLogs(host.managementAddress, opts.appName, 30, managementKey).catch(() => "");
      throw new Error(`Panel health check failed: ${health.error || "unknown"}${logs ? `\n${logs}` : ""}`);
    }
    onProgress("done", `Panel deployed: https://${domain}`);
    return { ok: true, domain, serverIp: host.managementAddress, internalTls: domain.endsWith(".nip.io") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (managementKey) {
      await removeContainer(host.managementAddress, opts.appName, managementKey).catch(() => {});
    }
    if (volumeId && serverId) {
      const server = db.getServer(serverId);
      if (server) await defaultStorageDriverForServer(server).delete(volumeId, server).catch(() => {});
    }
    if (serverId) db.deleteServer(serverId);
    return { ok: false, error: message };
  }
}
