import { sshExec } from "./ssh.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

function webhookReceiverScript(): string {
  return `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
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
  const appendLog = (msg) => { try { appendFileSync(logFile, ts + " " + msg + "\\n"); } catch {} };

  appendLog("Starting rebuild for " + appName);
  const appDir = "/home/deploy/apps/" + appName;
  let cmds;

  if (meta.deployMode === "compose") {
    const envFlag = meta.envFile ? " --env-file " + meta.envFile : "";
    cmds = [
      "cd " + appDir + " && git pull",
      "cd " + appDir + " && docker compose -f " + meta.composeFile + " -f docker-compose.ocd.yml -p " + appName + envFlag + " up -d --build"
    ];
  } else {
    cmds = [
      "cd " + appDir + " && git pull",
      "cd " + appDir + " && docker build -t " + appName + ":latest .",
      "docker rm -f " + appName + " 2>/dev/null || true",
      "cd " + appDir + " && docker run -d --name " + appName + " --restart unless-stopped " +
        "-p 127.0.0.1:" + meta.port + ":" + meta.containerPort + " " +
        (meta.envFile ? "--env-file " + meta.envFile + " " : "") +
        (meta.volumeMount ? "-v " + meta.volumeMount + " " : "") +
        appName + ":latest"
    ];
  }
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
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${routeJson}' http://localhost:2019/config/apps/http/servers/srv0/routes/0`,
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
  hostKey?: string,
  deployMode?: string,
  composeFile?: string,
  containerPort?: number,
  volumeMount?: string,
): Promise<void> {
  log("webhook", `Setting up webhook for app ${appName} on ${ip}`);

  await sshExec(ip, "mkdir -p /opt/ocd/webhooks", hostKey);

  // Write secret file
  const escapedSecret = secret.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${escapedSecret}' > /opt/ocd/webhooks/${appName}.secret && chmod 600 /opt/ocd/webhooks/${appName}.secret`, hostKey);

  // Write metadata file (includes compose info if applicable)
  const appDir = `/home/deploy/apps/${appName}`;
  const envFile = `${appDir}/.env.deploy`;
  const metaObj: Record<string, any> = { port: hostPort, containerPort: containerPort || hostPort, branch, envFile, volumeMount: volumeMount || "" };
  if (deployMode === "compose" && composeFile) {
    metaObj.deployMode = "compose";
    metaObj.composeFile = composeFile;
  }
  const meta = JSON.stringify(metaObj).replace(/'/g, "'\\''");
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
