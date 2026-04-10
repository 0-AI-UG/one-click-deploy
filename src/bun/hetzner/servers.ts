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
type HetznerServer = { id: number; status: string; public_net: { ipv4: { ip: string }; ipv6: { ip: string } }; name: string };
type WithFirewall = { firewall: HetznerFirewall };
type WithServer = { server: HetznerServer };

// --- Firewall ---

const FIREWALL_NAME = "one-click-deploy";

export async function addLBFirewallRule(
  firewallId: number,
  port: number,
  lbIpv4: string
): Promise<void> {
  log("firewall", `Adding LB firewall rule: port=${port} from=${lbIpv4}`);
  const fwData = await hetznerApi(`/firewalls/${firewallId}`) as unknown as WithFirewall;
  const existingRules = fwData.firewall.rules ?? [];

  // Check if rule already exists
  const exists = existingRules.some((r) =>
    r.direction === "in" && r.protocol === "tcp" && r.port === String(port) &&
    r.source_ips?.includes(`${lbIpv4}/32`)
  );
  if (exists) {
    log("firewall", "Rule already exists");
    return;
  }

  const newRules = [
    ...existingRules.map((r) => ({
      direction: r.direction,
      protocol: r.protocol,
      port: r.port,
      source_ips: r.source_ips,
      destination_ips: r.destination_ips,
      description: r.description,
    })),
    {
      direction: "in",
      protocol: "tcp",
      port: String(port),
      source_ips: [`${lbIpv4}/32`],
      description: `LB access to port ${port}`,
    },
  ];

  await hetznerApi(`/firewalls/${firewallId}/actions/set_rules`, {
    method: "POST",
    body: JSON.stringify({ rules: newRules }),
  });
  log("firewall", `LB firewall rule added for port ${port}`);
}

export async function removeLBFirewallRule(
  firewallId: number,
  port: number,
  lbIpv4: string
): Promise<void> {
  log("firewall", `Removing LB firewall rule: port=${port} from=${lbIpv4}`);
  const fwData2 = await hetznerApi(`/firewalls/${firewallId}`) as unknown as WithFirewall;
  const existingRules = fwData2.firewall.rules ?? [];
  const filteredRules = existingRules
    .filter((r) => !(
      r.direction === "in" && r.protocol === "tcp" && r.port === String(port) &&
      r.source_ips?.includes(`${lbIpv4}/32`)
    ))
    .map((r) => ({
      direction: r.direction,
      protocol: r.protocol,
      port: r.port,
      source_ips: r.source_ips,
      destination_ips: r.destination_ips,
      description: r.description,
    }));

  await hetznerApi(`/firewalls/${firewallId}/actions/set_rules`, {
    method: "POST",
    body: JSON.stringify({ rules: filteredRules }),
  });
  log("firewall", `LB firewall rule removed for port ${port}`);
}

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

// --- Cloud-Init ---

function cloudInitScript(): string {
  return `#!/bin/bash
exec > /var/log/cloud-init-deploy.log 2>&1
set -x

# Wait for apt/dpkg locks (unattended-upgrades runs on fresh Ubuntu)
wait_for_apt() {
  local max=60
  for i in $(seq 1 $max); do
    if ! fuser /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for apt lock... ($i/$max)"
    sleep 5
  done
  echo "WARNING: apt lock wait timed out"
}

wait_for_apt

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# docker-ce image already includes Docker, curl, git
# Firewall is handled by Hetzner Cloud Firewall (not UFW)
apt-get update -qq || { sleep 10; wait_for_apt; apt-get update -qq; }
apt-get install -y -qq unattended-upgrades hc-utils fail2ban || { sleep 10; wait_for_apt; apt-get install -y -qq unattended-upgrades hc-utils fail2ban; }
systemctl enable hc-agent && systemctl start hc-agent

# Create deploy user for running containers
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

# SSH hardening: disable root password login, only allow key-based auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
systemctl reload sshd || systemctl reload ssh || true

# fail2ban: protect SSH against brute-force
cat > /etc/fail2ban/jail.local <<'F2B'
[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 5
bantime = 3600
findtime = 600
F2B
systemctl enable fail2ban
systemctl restart fail2ban

# Enable automatic security updates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTOUPGRADE
systemctl enable unattended-upgrades

# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq || true
apt-get install -y -qq caddy || { sleep 10; wait_for_apt; apt-get install -y -qq caddy; }

# Configure Caddy with JSON config for admin API support
mkdir -p /etc/caddy/sites
cat > /etc/caddy/caddy.json <<'CADDYJSON'
{
  "admin": {
    "listen": "localhost:2019"
  },
  "apps": {
    "http": {
      "servers": {
        "srv0": {
          "listen": [":80", ":443"],
          "routes": []
        }
      }
    }
  }
}
CADDYJSON

# Override systemd to use JSON config
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf <<'OVERRIDE'
[Service]
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/caddy.json
ExecReload=/usr/bin/caddy reload --config /etc/caddy/caddy.json
OVERRIDE

systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy

# Install Bun runtime (for webhook receiver)
curl -fsSL https://bun.sh/install | bash
ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# Install Railpack + BuildKit for zero-config builds
curl -sSL https://railpack.com/install.sh | sh
docker run --rm --privileged -d --name buildkit moby/buildkit

# Signal ready
touch /root/.provisioned
`;
}

// --- Server Management ---

export async function createServer(opts: {
  name: string;
  server_type: string;
  location: string;
  ssh_key_name: string;
  firewall_id: number;
}): Promise<HetznerServer> {
  const data = await hetznerApi("/servers", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      server_type: opts.server_type,
      location: opts.location,
      image: "docker-ce",
      ssh_keys: [opts.ssh_key_name],
      firewalls: [{ firewall: opts.firewall_id }],
      labels: { managed_by: "one-click-deploy" },
      user_data: cloudInitScript(),
    }),
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
