import { hetznerApi } from "./api.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

type FirewallRule = {
  direction: string;
  protocol: string;
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string;
};

type HetznerFirewall = { id: number; rules?: FirewallRule[] };
type HetznerServer = {
  id: number;
  status: string;
  public_net: { ipv4: { ip: string }; ipv6: { ip: string } };
  private_net?: Array<{ network: number; ip: string }>;
  name: string;
};
type WithFirewall = { firewall: HetznerFirewall };
type WithServer = { server: HetznerServer };

// --- Firewall ---

const FIREWALL_NAME = "one-click-deploy";

export async function ensureFirewall(): Promise<number> {
  // Check if our firewall already exists
  const list = await hetznerApi(`/firewalls?name=${FIREWALL_NAME}`) as unknown as { firewalls: HetznerFirewall[] };
  const firewalls = list.firewalls;
  if (firewalls.length > 0) {
    const fw = firewalls[0];
    log("firewall", `Using existing firewall: id=${fw.id}`);

    // Verify required base rules exist (may have been wiped by a bug)
    const rules: FirewallRule[] = fw.rules ?? [];
    const hasSSH = rules.some((r) => r.direction === "in" && r.protocol === "tcp" && r.port === "22");
    const hasHTTP = rules.some((r) => r.direction === "in" && r.protocol === "tcp" && r.port === "80");
    const hasHTTPS = rules.some((r) => r.direction === "in" && r.protocol === "tcp" && r.port === "443");

    if (!hasSSH || !hasHTTP || !hasHTTPS) {
      log("firewall", `Repairing missing base rules (SSH=${hasSSH}, HTTP=${hasHTTP}, HTTPS=${hasHTTPS})`);
      const baseRules = [
        { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"], description: "SSH" },
        { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0", "::/0"], description: "HTTP" },
        { direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"], description: "HTTPS" },
        { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"], description: "ICMP ping" },
      ];
      // Merge: keep existing non-base rules, add missing base rules
      const existingExtra = rules
        .filter((r) => !(r.direction === "in" && r.protocol === "tcp" && r.port !== undefined && ["22", "80", "443"].includes(r.port)) &&
                       !(r.direction === "in" && r.protocol === "icmp"))
        .map((r) => ({ direction: r.direction, protocol: r.protocol, port: r.port, source_ips: r.source_ips, destination_ips: r.destination_ips, description: r.description }));
      await hetznerApi(`/firewalls/${fw.id}/actions/set_rules`, {
        method: "POST",
        body: JSON.stringify({ rules: [...baseRules, ...existingExtra] }),
      });
      log("firewall", "Firewall rules repaired");
    }

    return fw.id;
  }

  // Create firewall with SSH, HTTP, HTTPS inbound rules
  log("firewall", "Creating Hetzner Cloud Firewall...");
  const fwCreateData = await hetznerApi("/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: FIREWALL_NAME,
      labels: { managed_by: "one-click-deploy" },
      rules: [
        {
          direction: "in",
          protocol: "tcp",
          port: "22",
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "SSH",
        },
        {
          direction: "in",
          protocol: "tcp",
          port: "80",
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "HTTP",
        },
        {
          direction: "in",
          protocol: "tcp",
          port: "443",
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "HTTPS",
        },
        {
          direction: "in",
          protocol: "icmp",
          source_ips: ["0.0.0.0/0", "::/0"],
          description: "ICMP ping",
        },
      ],
    }),
  }) as unknown as WithFirewall;
  log("firewall", `Firewall created: id=${fwCreateData.firewall.id}`);
  return fwCreateData.firewall.id;
}

// --- Server Management ---

export async function createServer(opts: {
  name: string;
  server_type: string;
  location: string;
  ssh_key_name: string;
  firewall_id: number;
  network_id?: number;
  user_data: string;
}): Promise<HetznerServer> {
  const body: Record<string, unknown> = {
    name: opts.name,
    server_type: opts.server_type,
    location: opts.location,
    image: "docker-ce",
    ssh_keys: [opts.ssh_key_name],
    firewalls: [{ firewall: opts.firewall_id }],
    labels: { managed_by: "one-click-deploy" },
    user_data: opts.user_data,
  };
  if (opts.network_id) {
    // Attaching the network at create time avoids a second round trip and
    // ensures the server's private IPv4 is assigned before the first SSH
    // connection — the reconciler only has to pick up existing rows.
    body.networks = [opts.network_id];
  }
  const data = await hetznerApi("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as WithServer;
  return data.server;
}

export async function getHetznerServer(serverId: string): Promise<HetznerServer> {
  const data = await hetznerApi(`/servers/${serverId}`) as unknown as WithServer;
  return data.server;
}

/** Poll Hetzner API until server status is "running" (i.e. VM has booted). */
export async function waitForServerRunning(
  serverId: string | number,
  onStatus?: (msg: string) => void,
) {
  const maxAttempts = 90;
  const interval = 2_000; // 2s — Hetzner status transitions are fast
  log("wait-running", `Waiting for server ${serverId} to reach "running" status...`);
  for (let i = 0; i < maxAttempts; i++) {
    const server = await getHetznerServer(String(serverId));
    if (server.status === "running") {
      log("wait-running", `Server ${serverId} is running after ${i * 2}s`);
      onStatus?.("Server is running");
      return;
    }
    log("wait-running", `Server ${serverId} status: ${server.status} (attempt ${i + 1})`);
    onStatus?.(`Waiting for server to boot... (${server.status})`);
    await Bun.sleep(interval);
  }
  throw new Error("Server failed to boot — try creating a new server");
}

export async function deleteHetznerServer(serverId: string) {
  await hetznerApi(`/servers/${serverId}`, { method: "DELETE" });
}

export async function listHetznerServers(): Promise<HetznerServer[]> {
  const data = await hetznerApi(
    "/servers?label_selector=managed_by%3Done-click-deploy&per_page=50"
  ) as unknown as { servers: HetznerServer[] };
  return data.servers;
}
