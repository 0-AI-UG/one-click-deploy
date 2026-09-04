import { hetznerApi } from "./api.ts";
import { isNotFoundError } from "../../shared/providers/errors.ts";
import {
  PUBLIC_TCP_PORT_BASE,
  PUBLIC_TCP_PORT_COUNT,
  PUBLIC_UDP_PORT_BASE,
  PUBLIC_UDP_PORT_COUNT,
} from "../../shared/db/apps.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

export type FirewallRule = {
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

const FIREWALL_NAME = "open-cli-deployment";

const ANY_SOURCE = ["0.0.0.0/0", "::/0"];

/**
 * Base inbound rules every fleet server gets. The public raw TCP/UDP blocks
 * (apps.public_port pool, see traefik-provision.ts) are opened fleet-wide like
 * 80/443: only the panel's Traefik ever routes them, on workers nothing
 * listens there (replicas bind private IPs) — same stance as the
 * 20000-20199 internal block staying unreachable.
 */
export const BASE_FIREWALL_RULES: FirewallRule[] = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: ANY_SOURCE, description: "SSH" },
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY_SOURCE, description: "HTTP" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ANY_SOURCE, description: "HTTPS" },
  { direction: "in", protocol: "icmp", source_ips: ANY_SOURCE, description: "ICMP ping" },
  {
    direction: "in",
    protocol: "tcp",
    port: `${PUBLIC_TCP_PORT_BASE}-${PUBLIC_TCP_PORT_BASE + PUBLIC_TCP_PORT_COUNT - 1}`,
    source_ips: ANY_SOURCE,
    description: "Public TCP apps",
  },
  {
    direction: "in",
    protocol: "udp",
    port: `${PUBLIC_UDP_PORT_BASE}-${PUBLIC_UDP_PORT_BASE + PUBLIC_UDP_PORT_COUNT - 1}`,
    source_ips: ANY_SOURCE,
    description: "Public UDP apps",
  },
];

function sameRuleSlot(a: FirewallRule, b: FirewallRule): boolean {
  return a.direction === b.direction && a.protocol === b.protocol && (a.port ?? "") === (b.port ?? "");
}

/**
 * Reconcile an existing firewall's rules against BASE_FIREWALL_RULES: returns
 * the full desired rule set (base rules re-asserted, operator-added extras
 * preserved) when anything is missing, or null when already converged. Pure —
 * exported for tests; ensureFirewall applies the result via set_rules. This
 * is how a pre-existing fleet firewall picks up newly added base rules (e.g.
 * the public TCP/UDP blocks) without manual work.
 */
export function reconcileFirewallRules(existing: FirewallRule[]): FirewallRule[] | null {
  const missing = BASE_FIREWALL_RULES.filter((b) => !existing.some((r) => sameRuleSlot(r, b)));
  if (missing.length === 0) return null;
  const extras = existing
    .filter((r) => !BASE_FIREWALL_RULES.some((b) => sameRuleSlot(r, b)))
    .map((r) => ({
      direction: r.direction,
      protocol: r.protocol,
      port: r.port,
      source_ips: r.source_ips,
      destination_ips: r.destination_ips,
      description: r.description,
    }));
  return [...BASE_FIREWALL_RULES, ...extras];
}

export async function ensureFirewall(): Promise<number> {
  // Check if our firewall already exists
  const list = await hetznerApi(`/firewalls?name=${FIREWALL_NAME}`) as unknown as { firewalls: HetznerFirewall[] };
  const firewalls = list.firewalls;
  if (firewalls.length > 0) {
    const fw = firewalls[0];
    log("firewall", `Using existing firewall: id=${fw.id}`);

    // Converge missing base rules (new base rules after an upgrade, or rules
    // wiped by a bug), keeping any operator-added extras.
    const desired = reconcileFirewallRules(fw.rules ?? []);
    if (desired) {
      log("firewall", `Updating firewall rules (${(fw.rules ?? []).length} -> ${desired.length}): re-asserting base rules`);
      await hetznerApi(`/firewalls/${fw.id}/actions/set_rules`, {
        method: "POST",
        body: JSON.stringify({ rules: desired }),
      });
      log("firewall", "Firewall rules updated");
    }

    return fw.id;
  }

  log("firewall", "Creating Hetzner Cloud Firewall...");
  const fwCreateData = await hetznerApi("/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: FIREWALL_NAME,
      labels: { managed_by: "open-cli-deployment" },
      rules: BASE_FIREWALL_RULES,
    }),
  }) as unknown as WithFirewall;
  log("firewall", `Firewall created: id=${fwCreateData.firewall.id}`);
  return fwCreateData.firewall.id;
}

/** Ensure the fleet firewall is attached to an existing server. Provisioning
 * supplies it at create time; this repairs detachments and newly recreated
 * firewalls. Hetzner reports an already-applied relationship as a conflict,
 * which is a successful idempotent outcome here. */
export async function ensureFirewallAttached(firewallId: string | number, serverId: string | number): Promise<void> {
  try {
    await hetznerApi(`/firewalls/${firewallId}/actions/apply_to_resources`, {
      method: "POST",
      body: JSON.stringify({
        apply_to: [{ type: "server", server: { id: Number(serverId) } }],
      }),
    });
  } catch (error) {
    if (/already applied|already assigned|conflict/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
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
    labels: { managed_by: "open-cli-deployment" },
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
  try {
    await hetznerApi(`/servers/${serverId}`, { method: "DELETE" });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export async function listHetznerServers(): Promise<HetznerServer[]> {
  const data = await hetznerApi(
    "/servers?label_selector=managed_by%3Dopen-cli-deployment&per_page=50"
  ) as unknown as { servers: HetznerServer[] };
  return data.servers;
}
