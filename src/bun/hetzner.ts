import { getSettings } from "./db.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

function apiToken() {
  return getSettings().hetzner_api_token;
}

function dnsToken() {
  return getSettings().hetzner_dns_token;
}

async function hetznerApi(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = apiToken();
  if (!token) throw new Error("Hetzner API token not configured");
  const method = options.method || "GET";
  log("api", `${method} ${path}`);
  const start = Date.now();
  const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const elapsed = Date.now() - start;
  if (!res.ok) {
    const body = await res.text();
    log("api", `${method} ${path} FAILED ${res.status} in ${elapsed}ms: ${body}`);
    throw new Error(`Hetzner API error ${res.status}: ${body}`);
  }
  log("api", `${method} ${path} OK ${res.status} in ${elapsed}ms`);
  return res.json();
}

async function hetznerDns(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = dnsToken();
  if (!token) throw new Error("Hetzner DNS token not configured");
  const method = options.method || "GET";
  log("dns", `${method} ${path}`);
  const start = Date.now();
  const res = await fetch(`https://dns.hetzner.com/api/v1${path}`, {
    ...options,
    headers: {
      "Auth-API-Token": token,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const elapsed = Date.now() - start;
  if (!res.ok) {
    const body = await res.text();
    log("dns", `${method} ${path} FAILED ${res.status} in ${elapsed}ms: ${body}`);
    throw new Error(`Hetzner DNS error ${res.status}: ${body}`);
  }
  log("dns", `${method} ${path} OK ${res.status} in ${elapsed}ms`);
  return res.json();
}

// --- Server Management ---

export async function createServer(opts: {
  name: string;
  server_type: string;
  location: string;
  ssh_key_name: string;
}) {
  const data = await hetznerApi("/servers", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      server_type: opts.server_type,
      location: opts.location,
      image: "docker-ce",
      ssh_keys: [opts.ssh_key_name],
      labels: { managed_by: "one-click-deploy" },
      user_data: cloudInitScript(),
    }),
  });
  return data.server;
}

export async function getHetznerServer(serverId: string) {
  const data = await hetznerApi(`/servers/${serverId}`);
  return data.server;
}

export async function deleteHetznerServer(serverId: string) {
  await hetznerApi(`/servers/${serverId}`, { method: "DELETE" });
}

export async function listHetznerServers() {
  const data = await hetznerApi(
    "/servers?label_selector=managed_by%3Done-click-deploy&per_page=50"
  );
  return data.servers;
}

// --- SSH Keys ---

import path from "path";
import { existsSync, readFileSync, mkdirSync } from "fs";

const sshDir = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".one-click-deploy",
  "ssh"
);

async function getOrCreateLocalKeyPair(): Promise<{ publicKey: string; privateKeyPath: string }> {
  mkdirSync(sshDir, { recursive: true });
  const keyPath = path.join(sshDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (!existsSync(keyPath)) {
    log("ssh-key", `Generating new Ed25519 key at ${keyPath}`);
    const proc = Bun.spawn(
      ["ssh-keygen", "-t", "ed25519", "-f", keyPath, "-N", "", "-C", "one-click-deploy"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
    log("ssh-key", "Key generated");
  } else {
    log("ssh-key", `Using existing key at ${keyPath}`);
  }

  const publicKey = readFileSync(pubPath, "utf-8").trim();
  return { publicKey, privateKeyPath: keyPath };
}

export async function ensureSshKey(name: string) {
  log("ssh-key", `Ensuring SSH key "${name}" exists...`);
  const { publicKey, privateKeyPath } = await getOrCreateLocalKeyPair();

  const existing = await hetznerApi(`/ssh_keys?name=${name}`);
  if (existing.ssh_keys.length > 0) {
    log("ssh-key", `Found existing SSH key on Hetzner: id=${existing.ssh_keys[0].id}`);
    return { ...existing.ssh_keys[0], privateKeyPath };
  }

  log("ssh-key", "Uploading SSH key to Hetzner...");
  const data = await hetznerApi("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  });
  log("ssh-key", `SSH key uploaded: id=${data.ssh_key.id}`);
  return { ...data.ssh_key, privateKeyPath };
}

export function getSshKeyPath(): string {
  return path.join(sshDir, "id_ed25519");
}

// --- DNS ---

export async function createDnsRecord(opts: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
}) {
  const data = await hetznerDns("/records", {
    method: "POST",
    body: JSON.stringify({
      zone_id: opts.zone_id,
      name: opts.name,
      type: opts.type,
      value: opts.value,
      ttl: opts.ttl ?? 300,
    }),
  });
  return data.record;
}

export async function deleteDnsRecord(recordId: string) {
  await hetznerDns(`/records/${recordId}`, { method: "DELETE" });
}

export async function listDnsZones() {
  const data = await hetznerDns("/zones");
  return data.zones;
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

# Install essentials (docker comes from the image)
apt-get update -qq || { sleep 10; wait_for_apt; apt-get update -qq; }
apt-get install -y -qq curl git ufw unattended-upgrades || { sleep 10; wait_for_apt; apt-get install -y -qq curl git ufw unattended-upgrades; }

# Create deploy user for running containers
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

# Enable automatic security updates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTOUPGRADE
systemctl enable unattended-upgrades

# Firewall: only SSH, HTTP, HTTPS
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Install Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq || true
apt-get install -y -qq caddy || { sleep 10; wait_for_apt; apt-get install -y -qq caddy; }

# Create Caddyfile with security headers
mkdir -p /etc/caddy/sites
cat > /etc/caddy/Caddyfile <<'CADDY'
{
    email admin@localhost
}

(security_headers) {
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        X-XSS-Protection "1; mode=block"
        -Server
    }
}

import /etc/caddy/sites/*.caddy
CADDY

# Enable and start Caddy
systemctl enable caddy
systemctl restart caddy

# Signal ready
touch /root/.provisioned
`;
}

// --- Remote Commands via SSH ---

export async function sshExec(
  ip: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const keyPath = getSshKeyPath();
  const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
  log("ssh", `Exec on ${ip}: ${shortCmd}`);
  const start = Date.now();
  const proc = Bun.spawn(
    [
      "ssh",
      "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      command,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const elapsed = Date.now() - start;
  if (exitCode !== 0) {
    log("ssh", `FAILED (exit=${exitCode}) in ${elapsed}ms: ${stderr.trim().slice(0, 200)}`);
  } else {
    log("ssh", `OK in ${elapsed}ms (stdout=${stdout.trim().length} bytes)`);
  }
  return { stdout, stderr, exitCode };
}

export async function waitForServer(
  ip: string,
  maxAttempts = 30,
  onStatus?: (msg: string) => void,
) {
  log("wait", `Polling ${ip} for provisioning (max ${maxAttempts} attempts, 10s interval)...`);
  for (let i = 0; i < maxAttempts; i++) {
    const elapsed = i * 10;
    try {
      log("wait", `Attempt ${i + 1}/${maxAttempts}...`);
      const result = await sshExec(ip, "test -f /root/.provisioned && echo ok");
      if (result.stdout.trim() === "ok") {
        log("wait", `Server ${ip} ready after ${i + 1} attempts`);
        onStatus?.("Server ready");
        return true;
      }
      // SSH works but cloud-init still running — check what's happening
      const ps = await sshExec(ip, "ps -eo comm= | grep -E 'apt|dpkg|curl|docker|caddy|cloud-init' | head -1");
      const running = ps.stdout.trim();
      const detail = running ? `installing ${running}` : "finishing setup";
      log("wait", `Not ready yet — ${detail}`);
      onStatus?.(`Provisioning... ${detail} (${elapsed}s)`);
    } catch (err) {
      log("wait", `Attempt ${i + 1} error: ${err instanceof Error ? err.message : err}`);
      onStatus?.(`Waiting for SSH... (${elapsed}s)`);
    }
    await Bun.sleep(10_000);
  }
  // Grab diagnostics before throwing
  try {
    const diag = await sshExec(ip, "cat /var/log/cloud-init-deploy.log | tail -30 2>/dev/null; echo '---'; cloud-init status 2>/dev/null");
    log("wait", `Timeout diagnostics:\n${diag.stdout}\n${diag.stderr}`);
  } catch {}
  throw new Error(`Server ${ip} did not become ready after ${maxAttempts * 10}s`);
}

export async function deployCaddySite(
  ip: string,
  domain: string,
  containerPort: number,
  internalTls: boolean = false
) {
  log("caddy", `Deploying site: domain=${domain} port=${containerPort} internalTls=${internalTls}`);
  const siteConfig = internalTls
    ? `${domain} {\n  tls internal\n  import security_headers\n  reverse_proxy localhost:${containerPort}\n}\n`
    : `${domain} {\n  import security_headers\n  reverse_proxy localhost:${containerPort}\n}\n`;
  const escaped = siteConfig.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${escaped}' > /etc/caddy/sites/${domain}.caddy`);
  log("caddy", "Site config written, reloading Caddy...");
  await sshExec(ip, "caddy reload --config /etc/caddy/Caddyfile");
  log("caddy", "Caddy reloaded");
}

export async function removeCaddySite(ip: string, domain: string) {
  log("caddy", `Removing site: ${domain}`);
  await sshExec(ip, `rm -f /etc/caddy/sites/${domain}.caddy`);
  await sshExec(ip, "caddy reload --config /etc/caddy/Caddyfile");
  log("caddy", `Site ${domain} removed`);
}

export async function cloneAndBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number;
    envVars: Record<string, string>;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Clone or pull repo
  emit("Cloning repository...");
  log("build", `Cloning ${opts.gitRepo} into ${appDir}`);
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps`);
  const cloneResult = await sshExec(
    ip,
    asUser(`if [ -d "${appDir}/.git" ]; then cd ${appDir} && git pull; else rm -rf ${appDir} && git clone ${opts.gitRepo} ${appDir}; fi`)
  );
  if (cloneResult.exitCode !== 0) {
    throw new Error(`Git clone failed: ${cloneResult.stderr}`);
  }
  log("build", `Clone done, stdout: ${cloneResult.stdout.trim().slice(0, 200)}`);

  // Find Dockerfile
  emit("Searching for Dockerfile...");
  const findResult = await sshExec(
    ip,
    asUser(`cd ${appDir} && if [ -f Dockerfile ]; then echo Dockerfile; elif [ -f docker/Dockerfile ]; then echo docker/Dockerfile; else find . -maxdepth 3 -name Dockerfile -type f | head -1 | sed 's|^\\./||'; fi`)
  );
  const dockerfilePath = findResult.stdout.trim();
  if (!dockerfilePath) {
    throw new Error("No Dockerfile found in repository");
  }
  log("build", `Found Dockerfile: ${dockerfilePath}`);
  emit(`Found Dockerfile at: ${dockerfilePath}`);

  // Stop existing container if any
  log("build", `Removing existing container ${opts.name} (if any)`);
  await sshExec(ip, asUser(`docker rm -f ${opts.name} 2>/dev/null || true`));

  // Build image
  emit("Building Docker image...");
  const dockerContext = dockerfilePath.includes("/")
    ? dockerfilePath.substring(0, dockerfilePath.lastIndexOf("/"))
    : ".";
  const buildCmd = `cd ${appDir} && docker build -t ${opts.name}:latest -f ${dockerfilePath} ${dockerContext}`;
  log("build", `Docker build command: ${buildCmd}`);
  const dockerBuildStart = Date.now();
  const buildResult = await sshExec(ip, asUser(buildCmd));
  if (buildResult.exitCode !== 0) {
    log("build", `Docker build stderr: ${buildResult.stderr.slice(0, 500)}`);
    throw new Error(`Docker build failed: ${buildResult.stderr}`);
  }
  log("build", `Docker build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully");

  // Build env flags
  const envFlags = Object.entries(opts.envVars)
    .map(([k, v]) => `-e ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");

  // Run container
  emit("Starting container...");
  const cmd = `docker run -d --name ${opts.name} --restart unless-stopped -p 127.0.0.1:${opts.port}:${opts.port} ${envFlags} ${opts.name}:latest`;
  log("build", `Docker run: ${cmd}`);
  const result = await sshExec(ip, asUser(cmd));
  if (result.exitCode !== 0) {
    log("build", `Docker run stderr: ${result.stderr}`);
    throw new Error(`Failed to start container: ${result.stderr}`);
  }
  log("build", `Container started: ${result.stdout.trim().slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
  return { containerId: result.stdout.trim(), dockerfilePath };
}

export async function removeContainer(ip: string, name: string) {
  await sshExec(ip, `su - deploy -c "docker rm -f ${name} 2>/dev/null || true"`);
}
