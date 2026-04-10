import path from "path";
import { sshExec } from "./ssh.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

function scaleDaemonScript(): string {
  return `#!/usr/bin/env bun
const CONFIG_PATH = "/opt/ocd/scale-config.json";
const LOG_PATH = "/opt/ocd/scale-daemon.log";
const POLL_INTERVAL = 30_000; // 30s

function appendLog(msg) {
  const line = new Date().toISOString() + " " + msg + "\\n";
  try { require("fs").appendFileSync(LOG_PATH, line); } catch {}
  console.log(msg);
}

async function hetznerApi(token, path, opts = {}) {
  const res = await fetch("https://api.hetzner.cloud/v1" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...opts.headers },
  });
  if (!res.ok) {
    const status = res.status;
    await res.text(); // consume body
    throw new Error(status === 401 ? "Invalid API token" : status === 404 ? "Resource not found" : status >= 500 ? "Hetzner API error" : "API request failed (HTTP " + status + ")");
  }
  return res.json();
}

async function sshExec(ip, cmd) {
  const keyPath = path.join(process.cwd(), "data", "ssh", "id_ed25519");
  const proc = Bun.spawn(["ssh", "-i", keyPath, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "root@" + ip, cmd], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

async function getMetrics(serverIp, containerName) {
  try {
    const raw = await sshExec(serverIp, 'su - deploy -c "docker stats --no-stream --format \\'{{json .}}\\' ' + containerName + ' 2>/dev/null"');
    if (!raw) return null;
    const stats = JSON.parse(raw);
    return {
      cpu: parseFloat(stats.CPUPerc?.replace("%", "") || "0"),
      mem: parseFloat(stats.MemPerc?.replace("%", "") || "0"),
    };
  } catch { return null; }
}

async function addLBTarget(token, lbId, serverId) {
  return hetznerApi(token, "/load_balancers/" + lbId + "/actions/add_target", {
    method: "POST",
    body: JSON.stringify({ type: "server", server: { id: serverId }, use_private_net: false }),
  });
}

async function removeLBTarget(token, lbId, serverId) {
  return hetznerApi(token, "/load_balancers/" + lbId + "/actions/remove_target", {
    method: "POST",
    body: JSON.stringify({ type: "server", server: { id: serverId } }),
  });
}

let config;
function loadConfig() {
  try {
    config = JSON.parse(require("fs").readFileSync(CONFIG_PATH, "utf-8"));
    appendLog("Config loaded: " + config.apps.length + " app(s)");
  } catch (err) {
    appendLog("ERROR loading config: " + err.message);
    config = { hetzner_token: "", apps: [] };
  }
}

// Reload on SIGHUP
process.on("SIGHUP", () => {
  appendLog("SIGHUP received, reloading config...");
  loadConfig();
});

loadConfig();

async function poll() {
  if (!config.hetzner_token || !config.apps.length) return;

  for (const app of config.apps) {
    try {
      let totalCpu = 0, totalMem = 0, count = 0;

      for (const replica of app.replicas) {
        const m = await getMetrics(replica.server_ip, replica.container_name);
        if (m) {
          totalCpu += m.cpu;
          totalMem += m.mem;
          count++;
        }
      }

      if (count === 0) continue;
      const avgCpu = totalCpu / count;
      const avgMem = totalMem / count;

      // Check cooldown
      if (app._lastScale && Date.now() - app._lastScale < (app.cooldown_seconds || 300) * 1000) continue;

      // Scale up
      if ((avgCpu > app.cpu_threshold || avgMem > app.mem_threshold) && app.replicas.length < app.max_replicas) {
        appendLog("SCALE UP " + app.app_name + ": CPU=" + avgCpu.toFixed(1) + "% MEM=" + avgMem.toFixed(1) + "%");
        app._lastScale = Date.now();
        // For now just log — actual scaling is triggered by the panel polling this daemon's log
      }

      // Scale down
      if (avgCpu < app.cpu_threshold * 0.5 && avgMem < app.mem_threshold * 0.5 && app.replicas.length > app.min_replicas) {
        appendLog("SCALE DOWN " + app.app_name + ": CPU=" + avgCpu.toFixed(1) + "% MEM=" + avgMem.toFixed(1) + "%");
        app._lastScale = Date.now();
      }
    } catch (err) {
      appendLog("ERROR polling " + app.app_name + ": " + err.message);
    }
  }
}

appendLog("OCD scale daemon started (poll every " + (POLL_INTERVAL / 1000) + "s)");
setInterval(poll, POLL_INTERVAL);
poll();
`;
}

export async function deployScaleDaemon(ip: string, hostKey?: string): Promise<void> {
  log("scale-daemon", "Deploying scale daemon to " + ip);

  // Check if already deployed
  const check = await sshExec(ip, "test -f /opt/ocd/scale-daemon.ts && echo ok", hostKey);
  if (check.stdout.trim() === "ok") {
    log("scale-daemon", "Scale daemon already deployed, restarting...");
    await sshExec(ip, "systemctl restart ocd-scale-daemon", hostKey);
    return;
  }

  // Ensure Bun
  const bunCheck = await sshExec(ip, "test -x /usr/local/bin/bun && echo ok || echo missing", hostKey);
  if (bunCheck.stdout.trim() !== "ok") {
    await sshExec(ip, "curl -fsSL https://bun.sh/install | bash && cp /root/.bun/bin/bun /usr/local/bin/bun && chmod +x /usr/local/bin/bun", hostKey);
  }

  // Upload script via base64 to avoid quoting issues
  const scriptContent = scaleDaemonScript();
  const b64 = Buffer.from(scriptContent).toString("base64");
  await sshExec(ip, "mkdir -p /opt/ocd", hostKey);
  await sshExec(ip, `echo '${b64}' | base64 -d > /opt/ocd/scale-daemon.ts`, hostKey);

  // Create empty config
  await sshExec(ip, `echo '{"hetzner_token":"","apps":[]}' > /opt/ocd/scale-config.json`, hostKey);

  // Systemd unit
  const unit = `[Unit]
Description=OCD Scale Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bun run /opt/ocd/scale-daemon.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target`;
  const unitEscaped = unit.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${unitEscaped}' > /etc/systemd/system/ocd-scale-daemon.service`, hostKey);
  await sshExec(ip, "systemctl daemon-reload && systemctl enable ocd-scale-daemon && systemctl start ocd-scale-daemon", hostKey);

  log("scale-daemon", "Scale daemon deployed");
}

export async function updateScaleDaemonConfig(
  ip: string,
  config: {
    hetzner_token: string;
    apps: Array<{
      app_name: string;
      hetzner_lb_id: string;
      container_port: number;
      min_replicas: number;
      max_replicas: number;
      cpu_threshold: number;
      mem_threshold: number;
      cooldown_seconds: number;
      replicas: Array<{
        server_ip: string;
        container_name: string;
        host_port: number;
      }>;
    }>;
  },
  hostKey?: string
): Promise<void> {
  log("scale-daemon", "Updating scale daemon config on " + ip);
  const configB64 = Buffer.from(JSON.stringify(config, null, 2)).toString("base64");
  await sshExec(ip, `echo '${configB64}' | base64 -d > /opt/ocd/scale-config.json`, hostKey);
  // Send SIGHUP to reload
  await sshExec(ip, "kill -HUP $(systemctl show -p MainPID --value ocd-scale-daemon) 2>/dev/null || true", hostKey);
  log("scale-daemon", "Config updated and daemon signaled");
}

export async function removeScaleDaemon(ip: string, hostKey?: string): Promise<void> {
  log("scale-daemon", "Removing scale daemon from " + ip);
  await sshExec(ip, "systemctl stop ocd-scale-daemon 2>/dev/null; systemctl disable ocd-scale-daemon 2>/dev/null; rm -f /etc/systemd/system/ocd-scale-daemon.service; systemctl daemon-reload", hostKey);
  await sshExec(ip, "rm -f /opt/ocd/scale-daemon.ts /opt/ocd/scale-config.json /opt/ocd/scale-daemon.log", hostKey);
  log("scale-daemon", "Scale daemon removed");
}
