import type {
  ComputeProvider,
  DnsProvider,
  ProviderServer,
  ServerType,
} from "./types.ts";
import { hetznerApi } from "../hetzner/api.ts";
import {
  createServer,
  getHetznerServer,
  waitForServerRunning,
  deleteHetznerServer,
  listHetznerServers,
  ensureFirewall,
} from "../hetzner/servers.ts";
import {
  createVolume,
  attachVolume,
  detachVolume,
  resizeVolume,
  deleteVolume,
} from "../hetzner/volumes.ts";
import {
  createDnsRecord,
  deleteDnsRecord,
  listDnsZones,
} from "../hetzner/dns.ts";
import {
  ensureNetwork,
  attachServerToNetwork,
  getPrivateIpv4,
} from "../hetzner/networks.ts";
import { cloudInitScript } from "./cloud-init.ts";

export const hetznerCompute: ComputeProvider = {
  id: "hetzner",
  name: "Hetzner Cloud",

  async ensureSshKey(name, publicKey) {
    const existing = (await hetznerApi(
      `/ssh_keys?name=${name}`,
    )) as unknown as {
      ssh_keys: Array<{
        id: number;
        name: string;
        public_key: string;
      }>;
    };
    if (existing.ssh_keys.length > 0) {
      const remote = existing.ssh_keys[0];
      const remoteFp = remote.public_key?.trim().split(/\s+/).slice(0, 2).join(" ");
      const localFp = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
      if (remoteFp === localFp) {
        return { id: String(remote.id), name: remote.name };
      }
      // Local key differs — replace
      await hetznerApi(`/ssh_keys/${remote.id}`, { method: "DELETE" });
    }
    const data = (await hetznerApi("/ssh_keys", {
      method: "POST",
      body: JSON.stringify({ name, public_key: publicKey }),
    })) as unknown as { ssh_key: { id: number; name: string } };
    return { id: String(data.ssh_key.id), name: data.ssh_key.name };
  },

  async ensureFirewall() {
    const id = await ensureFirewall();
    return String(id);
  },

  async listServerTypes() {
    const data = (await hetznerApi(
      "/server_types?per_page=50",
    )) as Record<string, unknown>;
    const types: ServerType[] = [];
    for (const t of ((data.server_types as any[]) ?? [])) {
      if (t.deprecation?.announced) continue;
      types.push({
        name: t.name,
        description: t.description,
        cores: t.cores,
        memory: t.memory,
        disk: t.disk,
        locations: (t.prices ?? []).map(
          (p: { location: string }) => p.location,
        ),
      });
    }
    types.sort((a, b) => a.memory - b.memory || a.cores - b.cores);
    return types;
  },

  async createServer(opts) {
    const userData = cloudInitScript({
      extraPackages: ["hc-utils"],
      extraCommands: ["systemctl enable hc-agent && systemctl start hc-agent"],
    });
    const server = await createServer({
      name: opts.name,
      server_type: opts.serverType,
      location: opts.location,
      ssh_key_name: opts.sshKeyName,
      firewall_id: parseInt(opts.firewallId, 10),
      network_id: opts.networkId ? parseInt(opts.networkId, 10) : undefined,
    });
    const networkId = opts.networkId ? parseInt(opts.networkId, 10) : 0;
    const privateEntry = networkId
      ? (server.private_net ?? []).find((n) => n.network === networkId)
      : undefined;
    return {
      providerId: String(server.id),
      ipv4: server.public_net.ipv4.ip,
      ipv6: server.public_net.ipv6.ip || "",
      privateIpv4: privateEntry?.ip || "",
      status: "creating",
    };
  },

  async getServer(providerId) {
    const s = await getHetznerServer(providerId);
    return {
      providerId: String(s.id),
      ipv4: s.public_net.ipv4.ip,
      ipv6: s.public_net.ipv6.ip || "",
      status: s.status,
    };
  },

  async waitForRunning(providerId, onStatus) {
    await waitForServerRunning(providerId, onStatus);
  },

  async deleteServer(providerId) {
    await deleteHetznerServer(providerId);
  },

  async listServers() {
    const servers = await listHetznerServers();
    return servers.map((s) => ({
      providerId: String(s.id),
      ipv4: s.public_net.ipv4.ip,
      ipv6: s.public_net.ipv6.ip || "",
      status: s.status,
      name: s.name,
      type: "",
      location: "",
    }));
  },

  volumes: {
    async create(opts) {
      const v = await createVolume({
        name: opts.name,
        size: opts.sizeGb,
        server_id: parseInt(opts.serverId, 10),
        location: opts.location,
      });
      return { providerId: String(v.id), linuxDevice: v.linux_device };
    },
    async get(volumeId) {
      const data = await hetznerApi(`/volumes/${volumeId}`) as any;
      const v = data.volume;
      return {
        providerId: String(v.id),
        name: v.name,
        sizeGb: v.size,
        location: v.location?.name ?? "",
        serverId: v.server ? String(v.server) : null,
      };
    },
    async list() {
      const data = await hetznerApi("/volumes?label_selector=managed_by%3Done-click-deploy&per_page=50") as any;
      return (data.volumes ?? []).map((v: any) => ({
        providerId: String(v.id),
        name: v.name,
        sizeGb: v.size,
        location: v.location?.name ?? "",
        serverId: v.server ? String(v.server) : null,
      }));
    },
    async attach(volumeId, serverId) {
      await attachVolume(volumeId, parseInt(serverId, 10));
    },
    async detach(volumeId) {
      await detachVolume(volumeId);
    },
    async resize(volumeId, sizeGb) {
      await resizeVolume(volumeId, sizeGb);
    },
    async delete(volumeId) {
      await deleteVolume(volumeId);
    },
  },

  networks: {
    async ensure() {
      const net = await ensureNetwork();
      return { id: String(net.id) };
    },
    async attachServer(serverId, networkId) {
      await attachServerToNetwork(serverId, parseInt(networkId, 10));
    },
    async getPrivateIpv4(serverId, networkId) {
      return getPrivateIpv4(serverId, parseInt(networkId, 10));
    },
  },

  async getPricing() {
    try {
      const data = await hetznerApi("/pricing");
      const pricing = data.pricing as any;
      const servers: Record<string, number> = {};
      for (const st of pricing?.server_types ?? []) {
        for (const price of st.prices ?? []) {
          const key = `${st.name}|${price.location}`;
          servers[key] = parseFloat(price.price_monthly?.gross ?? "0");
        }
      }
      const volGross = parseFloat(pricing?.volume?.price_per_gb_month?.gross ?? "");
      const volumePerGbMonth = isNaN(volGross) ? null : volGross;
      return { currency: "EUR", servers, volumePerGbMonth };
    } catch {
      return null;
    }
  },
};

export const hetznerDns: DnsProvider = {
  id: "hetzner-dns",
  name: "Hetzner DNS",

  async listZones() {
    const zones = await listDnsZones();
    return (zones ?? []).map((z: any) => ({ id: z.id, name: z.name }));
  },

  async createRecord(opts) {
    return createDnsRecord({
      zone_id: opts.zoneId,
      name: opts.name,
      type: opts.type,
      value: opts.value,
      ttl: opts.ttl,
    });
  },

  async deleteRecord(opts) {
    await deleteDnsRecord({
      zone_id: opts.zoneId,
      name: opts.name,
      type: opts.type,
      value: opts.value,
    });
  },
};
