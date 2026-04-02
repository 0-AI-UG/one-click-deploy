import { getSettings } from "./db.ts";
import { getSecret } from "./keychain.ts";
import { withRetry, isRetryableHttpError, isRetryableSshError } from "./retry.ts";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

async function apiToken(): Promise<string> {
  // Try keychain first, fall back to DB settings
  const keychainToken = await getSecret("hetzner_api_token");
  if (keychainToken) return keychainToken;
  return getSettings().hetzner_api_token ?? "";
}

async function dnsToken(): Promise<string> {
  const keychainToken = await getSecret("hetzner_dns_token");
  if (keychainToken) return keychainToken;
  return getSettings().hetzner_dns_token ?? "";
}

async function hetznerApi(
  apiPath: string,
  options: RequestInit = {}
): Promise<any> {
  const token = await apiToken();
  if (!token) throw new Error("Hetzner API token not configured");
  return withRetry(async () => {
    const method = options.method || "GET";
    log("api", `${method} ${apiPath}`);
    const start = Date.now();
    const res = await fetch(`https://api.hetzner.cloud/v1${apiPath}`, {
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
      log("api", `${method} ${apiPath} FAILED ${res.status} in ${elapsed}ms: ${body}`);
      throw new Error(`Hetzner API error ${res.status}: ${body}`);
    }
    log("api", `${method} ${apiPath} OK ${res.status} in ${elapsed}ms`);
    return res.json();
  }, { retryOn: isRetryableHttpError });
}

async function hetznerDns(
  apiPath: string,
  options: RequestInit = {}
): Promise<any> {
  const token = await dnsToken();
  if (!token) throw new Error("Hetzner DNS token not configured");
  return withRetry(async () => {
    const method = options.method || "GET";
    log("dns", `${method} ${apiPath}`);
    const start = Date.now();
    const res = await fetch(`https://dns.hetzner.com/api/v1${apiPath}`, {
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
      log("dns", `${method} ${apiPath} FAILED ${res.status} in ${elapsed}ms: ${body}`);
      throw new Error(`Hetzner DNS error ${res.status}: ${body}`);
    }
    log("dns", `${method} ${apiPath} OK ${res.status} in ${elapsed}ms`);
    return res.json();
  }, { retryOn: isRetryableHttpError });
}

// --- Server Management ---

// --- Firewall ---

const FIREWALL_NAME = "one-click-deploy";

export async function ensureFirewall(): Promise<number> {
  // Check if our firewall already exists
  const list = await hetznerApi(`/firewalls?name=${FIREWALL_NAME}`);
  if (list.firewalls.length > 0) {
    log("firewall", `Using existing firewall: id=${list.firewalls[0].id}`);
    return list.firewalls[0].id;
  }

  // Create firewall with SSH, HTTP, HTTPS inbound rules
  log("firewall", "Creating Hetzner Cloud Firewall...");
  const data = await hetznerApi("/firewalls", {
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
  });
  log("firewall", `Firewall created: id=${data.firewall.id}`);
  return data.firewall.id;
}

export async function createServer(opts: {
  name: string;
  server_type: string;
  location: string;
  ssh_key_name: string;
  firewall_id: number;
}) {
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

// --- Volumes ---

export async function createVolume(opts: {
  name: string;
  size: number; // GB
  server_id: number;
  location: string;
}): Promise<{ id: number; linux_device: string }> {
  log("volume", `Creating ${opts.size}GB volume "${opts.name}" for server ${opts.server_id}`);
  const data = await hetznerApi("/volumes", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      size: opts.size,
      server: opts.server_id,
      format: "ext4",
      automount: true,
      labels: { managed_by: "one-click-deploy" },
    }),
  });
  log("volume", `Volume created: id=${data.volume.id} device=${data.volume.linux_device}`);
  return { id: data.volume.id, linux_device: data.volume.linux_device };
}

export async function deleteVolume(volumeId: string) {
  // Detach first, then delete
  try {
    await hetznerApi(`/volumes/${volumeId}/actions/detach`, { method: "POST", body: "{}" });
    // Wait a moment for detach to complete
    await Bun.sleep(3000);
  } catch {}
  await hetznerApi(`/volumes/${volumeId}`, { method: "DELETE" });
  log("volume", `Volume ${volumeId} deleted`);
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

# docker-ce image already includes Docker, curl, git
# Firewall is handled by Hetzner Cloud Firewall (not UFW)
# Only install unattended-upgrades + Caddy
apt-get update -qq || { sleep 10; wait_for_apt; apt-get update -qq; }
apt-get install -y -qq unattended-upgrades || { sleep 10; wait_for_apt; apt-get install -y -qq unattended-upgrades; }

# Create deploy user for running containers
useradd -m -s /bin/bash deploy
usermod -aG docker deploy

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

# Signal ready
touch /root/.provisioned
`;
}

// --- Remote Commands via SSH ---

export async function sshExec(
  ip: string,
  command: string,
  hostKey?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const keyPath = getSshKeyPath();
  const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
  log("ssh", `Exec on ${ip}: ${shortCmd}`);
  const start = Date.now();

  let knownHostsFile = "/dev/null";
  let strictHostKeyChecking = "no";
  let tmpKnownHostsPath: string | null = null;

  if (hostKey) {
    // Write host key to temp file for verification
    tmpKnownHostsPath = `${tmpdir()}/ocd-known-hosts-${ip.replace(/\./g, "-")}-${Date.now()}`;
    writeFileSync(tmpKnownHostsPath, hostKey);
    knownHostsFile = tmpKnownHostsPath;
    strictHostKeyChecking = "yes";
  }

  try {
    const proc = Bun.spawn(
      [
        "ssh",
        "-i", keyPath,
        "-o", `StrictHostKeyChecking=${strictHostKeyChecking}`,
        "-o", `UserKnownHostsFile=${knownHostsFile}`,
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
  } finally {
    if (tmpKnownHostsPath) {
      try { unlinkSync(tmpKnownHostsPath); } catch {}
    }
  }
}

export async function captureHostKey(ip: string): Promise<string> {
  log("ssh", `Capturing host key for ${ip}`);
  const proc = Bun.spawn(
    ["ssh-keyscan", "-t", "ed25519", ip],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const hostKey = stdout.trim();
  if (!hostKey) {
    log("ssh", `Warning: no host key captured for ${ip}`);
  } else {
    log("ssh", `Host key captured for ${ip}: ${hostKey.slice(0, 60)}...`);
  }
  return hostKey;
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
  internalTls: boolean = false,
  hostKey?: string
) {
  log("caddy", `Deploying site via admin API: domain=${domain} port=${containerPort} internalTls=${internalTls}`);

  // Build the Caddy JSON config for this route
  const routeId = `ocd-${domain.replace(/\./g, "-")}`;
  const handler: any = {
    handler: "reverse_proxy",
    upstreams: [{ dial: `localhost:${containerPort}` }],
  };

  const route: any = {
    "@id": routeId,
    match: [{ host: [domain] }],
    handle: [
      {
        handler: "headers",
        response: {
          set: {
            "X-Content-Type-Options": ["nosniff"],
            "X-Frame-Options": ["DENY"],
            "Referrer-Policy": ["strict-origin-when-cross-origin"],
            "X-XSS-Protection": ["1; mode=block"],
          },
          deferred: true,
        },
      },
      handler,
    ],
    terminal: true,
  };

  const tlsPolicy: any = internalTls
    ? { automation: { policies: [{ subjects: [domain], issuers: [{ module: "internal" }] }] } }
    : {};

  // Try to delete existing route first (ignore errors if not found)
  await sshExec(
    ip,
    `curl -sf -X DELETE http://localhost:2019/id/${routeId} 2>/dev/null || true`,
    hostKey
  );

  // Add the route via the admin API
  const routeJson = JSON.stringify(route);
  const escaped = routeJson.replace(/'/g, "'\\''");
  const addResult = await sshExec(
    ip,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${escaped}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
    hostKey
  );

  if (addResult.exitCode !== 0) {
    log("caddy", `Admin API route add failed: ${addResult.stderr}. Falling back to config file.`);
    // Fallback: write config file and reload
    const siteConfig = internalTls
      ? `${domain} {\n  tls internal\n  reverse_proxy localhost:${containerPort}\n}\n`
      : `${domain} {\n  reverse_proxy localhost:${containerPort}\n}\n`;
    const fileEscaped = siteConfig.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${fileEscaped}' > /etc/caddy/sites/${domain}.caddy`, hostKey);
    await sshExec(ip, "caddy reload --config /etc/caddy/Caddyfile", hostKey);
    log("caddy", "Fallback: config file written and reloaded");
    return;
  }

  // If using internal TLS, set the TLS automation policy
  if (internalTls) {
    const tlsJson = JSON.stringify(tlsPolicy);
    const tlsEscaped = tlsJson.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `curl -sf -X PATCH -H 'Content-Type: application/json' -d '${tlsEscaped}' http://localhost:2019/config/apps/tls`,
      hostKey
    );
  }

  log("caddy", "Site configured via admin API");
}

export async function removeCaddySite(ip: string, domain: string, hostKey?: string) {
  log("caddy", `Removing site: ${domain}`);
  const routeId = `ocd-${domain.replace(/\./g, "-")}`;

  // Try admin API first
  const result = await sshExec(
    ip,
    `curl -sf -X DELETE http://localhost:2019/id/${routeId}`,
    hostKey
  );

  if (result.exitCode !== 0) {
    // Fallback: remove config file
    await sshExec(ip, `rm -f /etc/caddy/sites/${domain}.caddy`, hostKey);
    await sshExec(ip, "caddy reload --config /etc/caddy/Caddyfile", hostKey);
  }

  log("caddy", `Site ${domain} removed`);
}

export async function cloneAndBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number; // container port
    hostPort: number; // host-side port for docker binding
    envVars: Record<string, string>;
    volumeMount?: string; // e.g. "/mnt/data:/data" — host:container
    dockerfilePath?: string; // explicit path to Dockerfile in repo
    gitToken?: string; // GitHub PAT for private repos
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

  // Build clone URL — inject token for private GitHub repos
  let cloneUrl = opts.gitRepo;
  if (opts.gitToken && cloneUrl.match(/^https:\/\/github\.com\//)) {
    cloneUrl = cloneUrl.replace(
      /^https:\/\/github\.com\//,
      `https://x-access-token:${opts.gitToken}@github.com/`
    );
  }

  // Clone or pull repo
  emit("Cloning repository...");
  log("build", `Cloning ${opts.gitRepo} into ${appDir} (token: ${opts.gitToken ? "yes" : "no"})`);
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps`);
  const gitEnv = opts.gitToken ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
  const cloneResult = await sshExec(
    ip,
    asUser(`${gitEnv}if [ -d "${appDir}/.git" ]; then cd ${appDir} && git remote set-url origin ${cloneUrl} && git pull; else rm -rf ${appDir} && git clone ${cloneUrl} ${appDir}; fi`)
  );
  if (cloneResult.exitCode !== 0) {
    const stderr = cloneResult.stderr;
    const notFound = stderr.match(/Repository not found/i);
    const isAuthError = stderr.match(/could not read Username|Authentication failed|403/i);
    if (notFound && opts.gitToken) {
      throw new Error(`Git clone failed: repository not found. Check that the repo URL is correct and your GitHub token has access to it.`);
    }
    if ((isAuthError || notFound) && !opts.gitToken) {
      throw new Error(`Git clone failed: repository requires authentication. Add a GitHub Personal Access Token in Settings.`);
    }
    if (isAuthError && opts.gitToken) {
      throw new Error(`Git clone failed: authentication rejected. Check that your GitHub token is valid and has the "repo" scope.`);
    }
    throw new Error(`Git clone failed: ${stderr}`);
  }

  // Strip token from git remote to avoid persisting credentials on server
  if (opts.gitToken && cloneUrl !== opts.gitRepo) {
    await sshExec(ip, asUser(`cd ${appDir} && git remote set-url origin ${opts.gitRepo}`));
  }
  log("build", `Clone done, stdout: ${cloneResult.stdout.trim().slice(0, 200)}`);

  // Find Dockerfile
  let dockerfilePath = opts.dockerfilePath?.replace(/^\/+/, "");
  if (dockerfilePath) {
    emit(`Using specified Dockerfile: ${dockerfilePath}`);
    const checkResult = await sshExec(ip, asUser(`test -f ${appDir}/${dockerfilePath} && echo ok`));
    if (checkResult.stdout.trim() !== "ok") {
      throw new Error(`Dockerfile not found at "${dockerfilePath}" in the repository. The path should be relative to the repo root, e.g. "Dockerfile" or "docker/Dockerfile".`);
    }
    log("build", `Using specified Dockerfile: ${dockerfilePath}`);
  } else {
    emit("Searching for Dockerfile...");
    const findResult = await sshExec(
      ip,
      asUser(`cd ${appDir} && if [ -f Dockerfile ]; then echo Dockerfile; elif [ -f docker/Dockerfile ]; then echo docker/Dockerfile; else find . -maxdepth 3 -name Dockerfile -type f | head -1 | sed 's|^\\./||'; fi`)
    );
    dockerfilePath = findResult.stdout.trim();
    if (!dockerfilePath) {
      throw new Error("No Dockerfile found in repository");
    }
    log("build", `Found Dockerfile: ${dockerfilePath}`);
    emit(`Found Dockerfile at: ${dockerfilePath}`);
  }

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

  // Write env file to server (avoids shell injection via env var values)
  const envFileEntries = Object.entries(opts.envVars);
  let envFileFlag = "";
  if (envFileEntries.length > 0) {
    const envFilePath = `/home/deploy/apps/${opts.name}/.env.deploy`;
    const envFileContent = envFileEntries
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const escapedContent = envFileContent.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`);
    envFileFlag = `--env-file ${envFilePath}`;
  }

  // Run container
  emit("Starting container...");
  const volumeFlag = opts.volumeMount ? `-v ${opts.volumeMount}` : "";
  const cmd = `docker run -d --name ${opts.name} --restart unless-stopped -p 127.0.0.1:${opts.hostPort}:${opts.port} ${envFileFlag} ${volumeFlag} ${opts.name}:latest`;
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

// --- Health Checks ---

export async function healthCheck(
  ip: string,
  containerName: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  log("health", `Checking health of ${containerName} on ${ip}:${port}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Check container is running
    const inspect = await sshExec(
      ip,
      `su - deploy -c "docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null"`,
      hostKey
    );
    if (inspect.stdout.trim() !== "true") {
      if (i < maxAttempts - 1) {
        log("health", `Container not running yet (attempt ${i + 1}/${maxAttempts})`);
        await Bun.sleep(3000);
        continue;
      }
      return { healthy: false, error: "Container is not running" };
    }

    // Check HTTP response
    const curl = await sshExec(
      ip,
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:${port}/`,
      hostKey
    );
    const statusCode = parseInt(curl.stdout.trim(), 10);
    if (statusCode >= 200 && statusCode < 500) {
      log("health", `Health check passed: HTTP ${statusCode}`);
      return { healthy: true, statusCode };
    }

    if (i < maxAttempts - 1) {
      log("health", `Health check returned ${statusCode} (attempt ${i + 1}/${maxAttempts})`);
      await Bun.sleep(3000);
    } else {
      return {
        healthy: false,
        statusCode: isNaN(statusCode) ? undefined : statusCode,
        error: `Health check failed with HTTP ${statusCode || "no response"}`,
      };
    }
  }

  return { healthy: false, error: "Health check timed out" };
}

// --- Container Logs ---

export async function getContainerLogs(
  ip: string,
  containerName: string,
  tail: number = 100,
  hostKey?: string
): Promise<string> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker logs --tail ${tail} ${containerName} 2>&1"`,
    hostKey
  );
  return result.stdout;
}

// --- Container Restart ---

// --- Webhook Receiver ---

function webhookReceiverScript(): string {
  return `#!/usr/bin/env bun
const WEBHOOKS_DIR = "/opt/ocd/webhooks";
const LOCK_COOLDOWN = 30_000; // 30s between rebuilds per app
const locks = new Map();

async function verifySignature(secret, body, signature) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

async function rebuild(appName, meta) {
  const logFile = WEBHOOKS_DIR + "/" + appName + ".log";
  const ts = new Date().toISOString();
  const appendLog = (msg) => Bun.write(Bun.file(logFile), { append: true }, ts + " " + msg + "\\n").catch(() => {});

  appendLog("Starting rebuild for " + appName);
  const appDir = "/home/deploy/apps/" + appName;
  const cmds = [
    "cd " + appDir + " && git pull",
    "cd " + appDir + " && docker build -t " + appName + ":latest .",
    "docker rm -f " + appName + " 2>/dev/null || true",
    "cd " + appDir + " && docker run -d --name " + appName + " --restart unless-stopped " +
      "-p 127.0.0.1:" + meta.port + ":" + meta.port + " " +
      (meta.envFile ? "--env-file " + meta.envFile + " " : "") +
      (meta.volumeMount ? "-v " + meta.volumeMount + " " : "") +
      appName + ":latest"
  ];
  for (const cmd of cmds) {
    const proc = Bun.spawn(["su", "-", "deploy", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    if (exit !== 0) {
      const stderr = await new Response(proc.stderr).text();
      appendLog("FAILED: " + cmd + " -> " + stderr.slice(0, 200));
      return false;
    }
  }
  appendLog("Rebuild complete for " + appName);
  return true;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 9876,
  async fetch(req) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const url = new URL(req.url);
    const appName = url.pathname.replace(/^\\//, "");
    if (!appName || appName.includes("/") || appName.includes("..")) {
      return new Response("Bad request", { status: 400 });
    }

    // Rate limit
    const lastBuild = locks.get(appName) || 0;
    if (Date.now() - lastBuild < LOCK_COOLDOWN) {
      return new Response("Too soon", { status: 429 });
    }

    // Read secret
    let secret;
    try { secret = await Bun.file(WEBHOOKS_DIR + "/" + appName + ".secret").text(); secret = secret.trim(); }
    catch { return new Response("App not configured", { status: 404 }); }

    // Verify signature
    const body = await req.text();
    const sig = req.headers.get("x-hub-signature-256");
    const valid = await verifySignature(secret, body, sig);
    if (!valid) return new Response("Invalid signature", { status: 401 });

    // Check branch
    let meta;
    try { meta = JSON.parse(await Bun.file(WEBHOOKS_DIR + "/" + appName + ".json").text()); }
    catch { return new Response("App metadata missing", { status: 500 }); }

    const payload = JSON.parse(body);
    const expectedRef = "refs/heads/" + (meta.branch || "main");
    if (payload.ref !== expectedRef) {
      return new Response("Branch mismatch", { status: 200 });
    }

    // Trigger rebuild
    locks.set(appName, Date.now());
    rebuild(appName, meta).catch(console.error);
    return new Response("Rebuild triggered", { status: 202 });
  },
});
console.log("OCD webhook receiver listening on " + server.hostname + ":" + server.port);
`;
}

export async function deployWebhookReceiver(ip: string, hostKey?: string): Promise<void> {
  log("webhook", `Deploying webhook receiver to ${ip}`);

  // Check if already deployed
  const check = await sshExec(ip, "test -f /opt/ocd/webhook-receiver.ts && echo ok", hostKey);
  if (check.stdout.trim() === "ok") {
    log("webhook", "Webhook receiver already deployed");
    return;
  }

  // Ensure Bun is installed on the server
  const bunCheck = await sshExec(ip, "test -x /usr/local/bin/bun && echo ok || echo missing", hostKey);
  if (bunCheck.stdout.trim() !== "ok") {
    log("webhook", "Installing Bun on server...");
    await sshExec(ip, "apt-get update -qq && apt-get install -y -qq unzip > /dev/null 2>&1", hostKey);
    await sshExec(ip, "curl -fsSL https://bun.sh/install | bash && cp /root/.bun/bin/bun /usr/local/bin/bun && chmod +x /usr/local/bin/bun", hostKey);
  }

  // Upload script
  const script = webhookReceiverScript().replace(/'/g, "'\\''");
  await sshExec(ip, `mkdir -p /opt/ocd/webhooks && echo '${script}' > /opt/ocd/webhook-receiver.ts`, hostKey);

  // Create systemd service
  const unit = `[Unit]
Description=OCD Webhook Receiver
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bun run /opt/ocd/webhook-receiver.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`;
  const unitEscaped = unit.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${unitEscaped}' > /etc/systemd/system/ocd-webhook.service`, hostKey);
  await sshExec(ip, "systemctl daemon-reload && systemctl enable ocd-webhook && systemctl start ocd-webhook", hostKey);

  log("webhook", "Webhook receiver deployed and started");
}

export async function ensureWebhookCaddyRoute(ip: string, hostKey?: string): Promise<void> {
  log("caddy", `Ensuring webhook Caddy route on ${ip}`);

  // Check if route already exists
  const check = await sshExec(
    ip,
    `curl -sf http://localhost:2019/id/ocd-webhook-route 2>/dev/null && echo exists || echo missing`,
    hostKey
  );
  if (check.stdout.trim().includes("exists")) {
    log("caddy", "Webhook route already exists");
    return;
  }

  // Add a route that matches /_ocd/webhook/* and proxies to the receiver
  const route = {
    "@id": "ocd-webhook-route",
    match: [{ path: ["/_ocd/webhook/*"] }],
    handle: [
      {
        handler: "rewrite",
        strip_path_prefix: "/_ocd/webhook",
      },
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: "localhost:9876" }],
      },
    ],
    terminal: true,
  };
  const routeJson = JSON.stringify(route).replace(/'/g, "'\\''");
  await sshExec(
    ip,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${routeJson}' http://localhost:2019/config/apps/http/servers/srv0/routes`,
    hostKey
  );

  log("caddy", "Webhook Caddy route created");
}

export async function setupAppWebhook(
  ip: string,
  appName: string,
  secret: string,
  hostPort: number,
  branch: string,
  gitToken?: string,
  hostKey?: string
): Promise<void> {
  log("webhook", `Setting up webhook for app ${appName} on ${ip}`);

  await sshExec(ip, "mkdir -p /opt/ocd/webhooks", hostKey);

  // Write secret file
  const escapedSecret = secret.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${escapedSecret}' > /opt/ocd/webhooks/${appName}.secret && chmod 600 /opt/ocd/webhooks/${appName}.secret`, hostKey);

  // Write metadata file
  const appDir = `/home/deploy/apps/${appName}`;
  const envFile = `${appDir}/.env.deploy`;
  const meta = JSON.stringify({ port: hostPort, branch, envFile, volumeMount: "" }).replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${meta}' > /opt/ocd/webhooks/${appName}.json`, hostKey);

  // Set up git credentials for private repos
  if (gitToken) {
    const credLine = `https://x-access-token:${gitToken}@github.com`.replace(/'/g, "'\\''");
    await sshExec(
      ip,
      `echo '${credLine}' > ${appDir}/.git-credentials && chown deploy:deploy ${appDir}/.git-credentials && chmod 600 ${appDir}/.git-credentials`,
      hostKey
    );
    await sshExec(
      ip,
      `su - deploy -c "cd ${appDir} && git config credential.helper 'store --file=${appDir}/.git-credentials'"`,
      hostKey
    );
  }

  log("webhook", `Webhook configured for ${appName}`);
}

export async function removeAppWebhook(ip: string, appName: string, hostKey?: string): Promise<void> {
  log("webhook", `Removing webhook config for ${appName} on ${ip}`);
  await sshExec(ip, `rm -f /opt/ocd/webhooks/${appName}.secret /opt/ocd/webhooks/${appName}.json /opt/ocd/webhooks/${appName}.log`, hostKey);
  // Remove git credentials
  await sshExec(ip, `rm -f /home/deploy/apps/${appName}/.git-credentials`, hostKey);
  log("webhook", `Webhook config removed for ${appName}`);
}

// --- Container Restart ---

export async function restartContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker restart ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to restart container: ${result.stderr}`);
  }
}

// --- Container Pause / Unpause ---

export async function pauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker pause ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pause container: ${result.stderr}`);
  }
}

export async function unpauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker unpause ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to unpause container: ${result.stderr}`);
  }
}

// --- Auth proxy for password-protected deployments ---

const AUTH_PROXY_PORT_OFFSET = 10000;

export function authProxyPort(hostPort: number): number {
  return hostPort + AUTH_PROXY_PORT_OFFSET;
}

function authProxyScript(appName: string, password: string, appPort: number, listenPort: number): string {
  // HMAC-based cookie signing. Cookie = timestamp.signature
  return `const PASSWORD = ${JSON.stringify(password)};
const UPSTREAM = "http://127.0.0.1:${appPort}";
const COOKIE = "ocd_sess";
const MAX_AGE = 86400 * 7; // 7 days

const SECRET = new TextEncoder().encode(${JSON.stringify(appName + "-" + Date.now())});

async function sign(data) {
  const key = await crypto.subtle.importKey("raw", SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verify(token) {
  try {
    const [ts, sig] = token.split(".");
    if (!ts || !sig) return false;
    if (Date.now() / 1000 - parseInt(ts) > MAX_AGE) return false;
    const expected = await sign(ts);
    return expected === sig;
  } catch { return false; }
}

function getCookie(header, name) {
  const m = header?.match(new RegExp("(?:^|;\\\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function loginPage(err) {
  const html = \`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — ${appName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f0eb;color:#1a1a1a}
.gate{border:2.5px solid #1a1a1a;padding:32px;width:320px;background:#fff;
  box-shadow:6px 6px 0 #1a1a1a}
h1{font-size:13px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:20px;
  border-bottom:2px solid #1a1a1a;padding-bottom:8px}
input{width:100%;padding:10px;font-size:13px;font-family:inherit;
  border:2px solid #1a1a1a;background:#f5f0eb;margin-bottom:12px;outline:none}
input:focus{background:#fff;box-shadow:3px 3px 0 #1a1a1a}
button{width:100%;padding:10px;font-size:11px;font-family:inherit;font-weight:700;
  text-transform:uppercase;letter-spacing:.1em;border:2.5px solid #1a1a1a;
  background:#1a1a1a;color:#f5f0eb;cursor:pointer;transition:all .1s}
button:hover{background:#f5f0eb;color:#1a1a1a}
.err{font-size:10px;color:#c00;font-weight:700;margin-bottom:10px}
.sub{font-size:9px;color:#888;margin-top:14px;text-align:center}
</style></head><body>
<div class="gate">
<h1>${appName}</h1>
\${err ? '<div class="err">' + err + '</div>' : ''}
<form method="POST" action="/__ocd_login">
<input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Enter</button>
</form>
<div class="sub">Password protected</div>
</div></body></html>\`;
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html;charset=utf-8" } });
}

Bun.serve({
  port: ${listenPort},
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/__ocd_login" && req.method === "POST") {
      const form = await req.formData();
      const pw = form.get("password");
      if (pw === PASSWORD) {
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = await sign(ts);
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": COOKIE + "=" + encodeURIComponent(ts + "." + sig) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + MAX_AGE,
          },
        });
      }
      return loginPage("Wrong password");
    }

    const token = getCookie(req.headers.get("cookie"), COOKIE);
    if (!token || !(await verify(token))) return loginPage();

    const target = UPSTREAM + url.pathname + url.search;
    try {
      const headers = new Headers(req.headers);
      headers.delete("host");
      const resp = await fetch(target, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        redirect: "manual",
      });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (e) {
      return new Response("Upstream unavailable", { status: 502 });
    }
  },
});
console.log("Auth proxy for ${appName} on :" + ${listenPort});`;
}

export async function deployAuthProxy(
  ip: string,
  appName: string,
  password: string,
  appPort: number,
  hostKey?: string
): Promise<number> {
  const listenPort = authProxyPort(appPort);
  log("auth", `Deploying auth proxy for ${appName}: proxy=:${listenPort} -> app=:${appPort}`);

  // Ensure Bun is available and executable by the deploy user
  const bunCheck = await sshExec(ip, "su - deploy -c '/usr/local/bin/bun --version' 2>/dev/null && echo ok || echo missing", hostKey);
  if (!bunCheck.stdout.includes("ok")) {
    log("auth", "Installing Bun on server...");
    await sshExec(ip, "apt-get update -qq && apt-get install -y -qq unzip > /dev/null 2>&1", hostKey);
    const install = await sshExec(ip, "rm -f /usr/local/bin/bun && curl -fsSL https://bun.sh/install | bash && cp /root/.bun/bin/bun /usr/local/bin/bun && chmod 755 /usr/local/bin/bun", hostKey);
    if (install.exitCode !== 0) {
      throw new Error(`Failed to install Bun: ${install.stderr.trim()}`);
    }
  }

  const script = authProxyScript(appName, password, appPort, listenPort);
  const scriptPath = `/home/deploy/apps/${appName}/.auth-proxy.ts`;

  // Use base64 to safely transfer the script (avoids heredoc/quoting issues)
  const b64 = Buffer.from(script).toString("base64");
  await sshExec(ip, `mkdir -p /home/deploy/apps/${appName}`, hostKey);
  await sshExec(ip, `echo '${b64}' | base64 -d > ${scriptPath}`, hostKey);
  await sshExec(ip, `chown deploy:deploy ${scriptPath} && chmod 600 ${scriptPath}`, hostKey);

  const serviceName = `ocd-auth-${appName}`;

  // Stop any existing instance (transient or leftover permanent service)
  await sshExec(ip, `systemctl stop ${serviceName} 2>/dev/null; systemctl reset-failed ${serviceName} 2>/dev/null; rm -f /etc/systemd/system/${serviceName}.service; systemctl daemon-reload 2>/dev/null`, hostKey);

  // Launch as a transient systemd unit
  await sshExec(ip, [
    `systemd-run --unit=${serviceName}`,
    `--property=Restart=always --property=RestartSec=3`,
    `--uid=deploy`,
    `/usr/local/bin/bun run ${scriptPath}`,
  ].join(" "), hostKey);

  // Verify the service started
  await new Promise((r) => setTimeout(r, 1500));
  const status = await sshExec(ip, `systemctl is-active ${serviceName} 2>/dev/null`, hostKey);
  if (status.stdout.trim() !== "active") {
    const logs = await sshExec(ip, `journalctl -u ${serviceName} --no-pager -n 20 2>/dev/null`, hostKey);
    log("auth", `Auth proxy failed to start. Logs:\n${logs.stdout}`);
    throw new Error(`Auth proxy failed to start: ${logs.stdout.trim().slice(-200)}`);
  }

  log("auth", `Auth proxy for ${appName} deployed on port ${listenPort}`);
  return listenPort;
}

export async function removeAuthProxy(
  ip: string,
  appName: string,
  hostKey?: string
): Promise<void> {
  const serviceName = `ocd-auth-${appName}`;
  log("auth", `Removing auth proxy for ${appName}`);

  await sshExec(ip, `systemctl stop ${serviceName} 2>/dev/null; systemctl reset-failed ${serviceName} 2>/dev/null`, hostKey);
  await sshExec(ip, `rm -f /home/deploy/apps/${appName}/.auth-proxy.ts`, hostKey);

  log("auth", `Auth proxy for ${appName} removed`);
}
