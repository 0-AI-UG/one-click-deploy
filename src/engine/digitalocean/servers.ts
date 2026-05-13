import { doApi } from "./api.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [do:${context}]`, ...args);
}

export type DoNetworkV4 = { ip_address: string; netmask: string; gateway: string; type: "public" | "private" };
export type DoNetworkV6 = { ip_address: string; netmask: number; gateway: string; type: "public" | "private" };
export type DoDroplet = {
  id: number;
  name: string;
  status: string; // "new" | "active" | "off" | "archive"
  size_slug: string;
  region: { slug: string };
  networks: { v4: DoNetworkV4[]; v6: DoNetworkV6[] };
  vpc_uuid?: string;
  tags?: string[];
};

const FIREWALL_NAME = "one-click-deploy";
const MANAGED_TAG = "ocd-managed";

/** Public IPv4 from a droplet's networks block. */
export function publicIpv4(d: DoDroplet): string {
  return d.networks?.v4?.find((n) => n.type === "public")?.ip_address ?? "";
}
export function publicIpv6(d: DoDroplet): string {
  return d.networks?.v6?.find((n) => n.type === "public")?.ip_address ?? "";
}
export function privateIpv4(d: DoDroplet): string {
  return d.networks?.v4?.find((n) => n.type === "private")?.ip_address ?? "";
}

// --- SSH keys ---

export type DoSshKey = { id: number; name: string; fingerprint: string; public_key: string };

export async function ensureDoSshKey(name: string, publicKey: string): Promise<{ id: string; name: string }> {
  // DO does not support filtering by name, so paginate (typical projects have <100 keys).
  const list = await doApi(`/account/keys?per_page=200`) as { ssh_keys: DoSshKey[] };
  const localFp = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  const existing = (list.ssh_keys ?? []).find((k) => k.name === name);
  if (existing) {
    const remoteFp = existing.public_key.trim().split(/\s+/).slice(0, 2).join(" ");
    if (remoteFp === localFp) {
      return { id: String(existing.id), name: existing.name };
    }
    // Local key differs — replace.
    await doApi(`/account/keys/${existing.id}`, { method: "DELETE" });
  }
  const data = await doApi("/account/keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  }) as { ssh_key: DoSshKey };
  return { id: String(data.ssh_key.id), name: data.ssh_key.name };
}

// --- Firewall ---

type DoFirewallRule = {
  protocol: string;
  ports: string;
  sources?: { addresses?: string[]; tags?: string[] };
  destinations?: { addresses?: string[]; tags?: string[] };
};
type DoFirewall = {
  id: string;
  name: string;
  inbound_rules: DoFirewallRule[];
  outbound_rules: DoFirewallRule[];
  tags?: string[];
};

const BASE_INBOUND: DoFirewallRule[] = [
  { protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "tcp", ports: "80", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "tcp", ports: "443", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "icmp", ports: "0", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
];

const BASE_OUTBOUND: DoFirewallRule[] = [
  { protocol: "tcp", ports: "1-65535", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "udp", ports: "1-65535", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
  { protocol: "icmp", ports: "0", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
];

export async function ensureDoFirewall(): Promise<string> {
  const list = await doApi(`/firewalls?per_page=200`) as { firewalls: DoFirewall[] };
  const existing = (list.firewalls ?? []).find((f) => f.name === FIREWALL_NAME);
  if (existing) {
    log("firewall", `Using existing firewall: id=${existing.id}`);
    return existing.id;
  }
  log("firewall", "Creating DigitalOcean firewall...");
  const data = await doApi("/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: FIREWALL_NAME,
      tags: [MANAGED_TAG],
      inbound_rules: BASE_INBOUND,
      outbound_rules: BASE_OUTBOUND,
    }),
  }) as { firewall: DoFirewall };
  log("firewall", `Firewall created: id=${data.firewall.id}`);
  return data.firewall.id;
}

async function attachDropletToFirewall(firewallId: string, dropletId: number): Promise<void> {
  await doApi(`/firewalls/${firewallId}/droplets`, {
    method: "POST",
    body: JSON.stringify({ droplet_ids: [dropletId] }),
  });
}

// --- Server types (Droplet sizes) ---

type DoSize = {
  slug: string;
  description?: string;
  memory: number; // MB
  vcpus: number;
  disk: number; // GB
  regions: string[];
  available: boolean;
  price_monthly: number;
};

export async function listDoSizes(): Promise<DoSize[]> {
  const data = await doApi("/sizes?per_page=200") as { sizes: DoSize[] };
  return (data.sizes ?? []).filter((s) => s.available);
}

// --- Droplet lifecycle ---

export async function createDroplet(opts: {
  name: string;
  size: string;
  region: string;
  ssh_key_name: string; // resolved to fingerprint or id below
  ssh_key_id?: string;
  vpc_uuid?: string;
  user_data: string;
  tags?: string[];
}): Promise<DoDroplet> {
  const body: Record<string, unknown> = {
    name: opts.name,
    region: opts.region,
    size: opts.size,
    image: "ubuntu-24-04-x64",
    ssh_keys: opts.ssh_key_id ? [parseInt(opts.ssh_key_id, 10)] : [opts.ssh_key_name],
    user_data: opts.user_data,
    ipv6: true,
    monitoring: true,
    tags: [MANAGED_TAG, ...(opts.tags ?? [])],
  };
  if (opts.vpc_uuid) body.vpc_uuid = opts.vpc_uuid;
  const data = await doApi("/droplets", {
    method: "POST",
    body: JSON.stringify(body),
  }) as { droplet: DoDroplet };
  return data.droplet;
}

export async function getDroplet(dropletId: string | number): Promise<DoDroplet> {
  const data = await doApi(`/droplets/${dropletId}`) as { droplet: DoDroplet };
  return data.droplet;
}

export async function waitForDropletActive(
  dropletId: string | number,
  onStatus?: (msg: string) => void,
): Promise<void> {
  const maxAttempts = 120;
  const interval = 2_000;
  log("wait-active", `Waiting for droplet ${dropletId} to reach "active"...`);
  for (let i = 0; i < maxAttempts; i++) {
    const d = await getDroplet(dropletId);
    // DO droplets need a public IPv4 before they're usable.
    if (d.status === "active" && publicIpv4(d)) {
      log("wait-active", `Droplet ${dropletId} is active after ${i * 2}s`);
      onStatus?.("Server is running");
      return;
    }
    log("wait-active", `Droplet ${dropletId} status: ${d.status} (attempt ${i + 1})`);
    onStatus?.(`Waiting for server to boot... (${d.status})`);
    await Bun.sleep(interval);
  }
  throw new Error("Droplet failed to become active — try creating a new server");
}

export async function deleteDroplet(dropletId: string): Promise<void> {
  await doApi(`/droplets/${dropletId}`, { method: "DELETE" });
}

export async function listDoDroplets(): Promise<DoDroplet[]> {
  const data = await doApi(`/droplets?tag_name=${MANAGED_TAG}&per_page=200`) as { droplets: DoDroplet[] };
  return data.droplets ?? [];
}

export { attachDropletToFirewall };
