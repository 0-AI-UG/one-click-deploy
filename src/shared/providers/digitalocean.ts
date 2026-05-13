import type {
  ComputeProvider,
  DnsProvider,
  ServerType,
} from "./types.ts";
import { doApi } from "../../engine/digitalocean/api.ts";
import {
  createDroplet,
  getDroplet,
  waitForDropletActive,
  deleteDroplet,
  listDoDroplets,
  ensureDoSshKey,
  ensureDoFirewall,
  attachDropletToFirewall,
  listDoSizes,
  publicIpv4,
  publicIpv6,
  privateIpv4,
  type DoDroplet,
} from "../../engine/digitalocean/servers.ts";
import {
  ensureDoVpc,
  attachDropletToVpc,
  getDropletPrivateIp,
} from "../../engine/digitalocean/networks.ts";
import {
  createDoVolume,
  getDoVolume,
  listDoVolumes,
  attachDoVolume,
  detachDoVolume,
  resizeDoVolume,
  deleteDoVolume,
} from "../../engine/digitalocean/volumes.ts";
import {
  listDoDnsZones,
  createDoDnsRecord,
  deleteDoDnsRecord,
} from "../../engine/digitalocean/dns.ts";
import { cloudInitScript } from "./cloud-init.ts";
import { validateDigitalOceanToken } from "../validate.ts";

function toProviderServer(d: DoDroplet) {
  return {
    providerId: String(d.id),
    ipv4: publicIpv4(d),
    ipv6: publicIpv6(d),
    privateIpv4: privateIpv4(d),
    status: d.status,
  };
}

// Cloud-init additions for DO:
// - Install docker.io + docker-compose-plugin (DO's ubuntu image has no docker pre-installed).
// - One-shot systemd unit that mounts any DO block volume by-id to /mnt/<label>.
const DO_EXTRA_PACKAGES = ["docker.io", "docker-compose-plugin"];
const DO_EXTRA_COMMANDS = [
  "systemctl enable --now docker",
  // Mount any attached DO volumes by their stable by-id path.
  `cat > /usr/local/sbin/ocd-mount-do-volumes <<'MOUNTSH'
#!/bin/bash
set -e
for dev in /dev/disk/by-id/scsi-0DO_Volume_*; do
  [ -e "$dev" ] || continue
  label="\${dev##*scsi-0DO_Volume_}"
  mp="/mnt/$label"
  mkdir -p "$mp"
  mountpoint -q "$mp" || mount -o discard,defaults,noatime "$dev" "$mp"
  grep -q "$dev" /etc/fstab || echo "$dev $mp ext4 discard,defaults,noatime,nofail 0 0" >> /etc/fstab
done
MOUNTSH
chmod +x /usr/local/sbin/ocd-mount-do-volumes
cat > /etc/systemd/system/ocd-mount-do-volumes.service <<'UNIT'
[Unit]
Description=Mount DigitalOcean block volumes by label
After=local-fs.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/ocd-mount-do-volumes
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/udev/rules.d/99-ocd-do-volume.rules <<'UDEV'
KERNEL=="sd*", SUBSYSTEM=="block", ENV{ID_VENDOR}=="DO", ACTION=="add", RUN+="/bin/systemctl restart ocd-mount-do-volumes.service"
UDEV
systemctl enable ocd-mount-do-volumes.service
systemctl start ocd-mount-do-volumes.service || true
udevadm control --reload-rules || true`,
];

function doCloudInit(): string {
  return cloudInitScript({
    extraPackages: DO_EXTRA_PACKAGES,
    extraCommands: DO_EXTRA_COMMANDS,
  });
}

export const digitaloceanCompute: ComputeProvider = {
  id: "digitalocean",
  name: "DigitalOcean",
  tokenKey: "digitalocean_api_token",

  validateToken(token) {
    return validateDigitalOceanToken(token);
  },

  async verifyToken(token) {
    const res = await fetch("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return;
    if (res.status === 401) throw new Error("Invalid DigitalOcean API token");
    throw new Error(`DigitalOcean API error (${res.status})`);
  },

  async ensureSshKey(name, publicKey) {
    return ensureDoSshKey(name, publicKey);
  },

  async ensureFirewall() {
    return ensureDoFirewall();
  },

  async listServerTypes() {
    const sizes = await listDoSizes();
    const types: ServerType[] = sizes.map((s) => ({
      name: s.slug,
      description: s.description || s.slug,
      cores: s.vcpus,
      memory: s.memory / 1024, // MB -> GB to match Hetzner units
      disk: s.disk,
      locations: s.regions,
    }));
    types.sort((a, b) => a.memory - b.memory || a.cores - b.cores);
    return types;
  },

  async createServer(opts) {
    const userData = opts.userData || doCloudInit();
    const droplet = await createDroplet({
      name: opts.name,
      size: opts.serverType,
      region: opts.location,
      ssh_key_name: opts.sshKeyName,
      vpc_uuid: opts.networkId || undefined,
      user_data: userData,
    });
    // Firewall attachment happens post-create (DO has no inline firewall on droplet create).
    try {
      await attachDropletToFirewall(opts.firewallId, droplet.id);
    } catch (err) {
      // Non-fatal: surface but don't fail the whole provision — caller can retry.
      console.warn(`[do] firewall attach failed: ${err}`);
    }
    return toProviderServer(droplet);
  },

  async getServer(providerId) {
    const d = await getDroplet(providerId);
    return toProviderServer(d);
  },

  async waitForRunning(providerId, onStatus) {
    await waitForDropletActive(providerId, onStatus);
  },

  async deleteServer(providerId) {
    await deleteDroplet(providerId);
  },

  async listServers() {
    const droplets = await listDoDroplets();
    return droplets.map((d) => ({
      ...toProviderServer(d),
      name: d.name,
      type: d.size_slug,
      location: d.region?.slug ?? "",
    }));
  },

  volumes: {
    async create(opts) {
      const v = await createDoVolume({
        name: opts.name,
        size_gb: opts.sizeGb,
        droplet_id: parseInt(opts.serverId, 10),
        region: opts.location,
      });
      return { providerId: v.id, linuxDevice: v.linux_device };
    },
    async get(volumeId) {
      const v = await getDoVolume(volumeId);
      return {
        providerId: v.id,
        name: v.name,
        sizeGb: v.size_gigabytes,
        location: v.region?.slug ?? "",
        serverId: v.droplet_ids?.[0] ? String(v.droplet_ids[0]) : null,
      };
    },
    async list() {
      const vols = await listDoVolumes();
      return vols.map((v) => ({
        providerId: v.id,
        name: v.name,
        sizeGb: v.size_gigabytes,
        location: v.region?.slug ?? "",
        serverId: v.droplet_ids?.[0] ? String(v.droplet_ids[0]) : null,
      }));
    },
    async attach(volumeId, serverId) {
      await attachDoVolume(volumeId, parseInt(serverId, 10));
    },
    async detach(volumeId) {
      await detachDoVolume(volumeId);
    },
    async resize(volumeId, sizeGb) {
      await resizeDoVolume(volumeId, sizeGb);
    },
    async delete(volumeId) {
      await deleteDoVolume(volumeId);
    },
  },

  networks: {
    async ensure() {
      // The region is determined by the caller's default_location setting,
      // resolved lazily from settings if missing.
      const { id } = await ensureDoVpc();
      return { id };
    },
    async attachServer(serverId, networkId) {
      await attachDropletToVpc(serverId, networkId);
    },
    async getPrivateIpv4(serverId, _networkId) {
      return getDropletPrivateIp(serverId);
    },
  },

  async getPricing() {
    try {
      const sizes = await listDoSizes();
      const servers: Record<string, number> = {};
      for (const s of sizes) {
        for (const region of s.regions) {
          // DO publishes flat per-droplet pricing (region-independent).
          servers[`${s.slug}|${region}`] = s.price_monthly;
        }
      }
      // DO block volumes: $0.10/GB-month flat. No API; safe to hardcode.
      return { currency: "USD", servers, volumePerGbMonth: 0.1 };
    } catch {
      return null;
    }
  },
};

export const digitaloceanDns: DnsProvider = {
  id: "digitalocean-dns",
  name: "DigitalOcean DNS",

  async listZones() {
    return listDoDnsZones();
  },

  async createRecord(opts) {
    return createDoDnsRecord({
      zone_id: opts.zoneId,
      name: opts.name,
      type: opts.type,
      value: opts.value,
      ttl: opts.ttl,
    });
  },

  async deleteRecord(opts) {
    await deleteDoDnsRecord({
      zone_id: opts.zoneId,
      name: opts.name,
      type: opts.type,
      value: opts.value,
    });
  },
};

// Silence linter for unused doApi import — kept exported for future use.
void doApi;
