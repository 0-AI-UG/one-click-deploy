import { sshExec, describeFailure } from "./ssh.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

const AUTH_PROXY_PORT_OFFSET = 10000;

export function authProxyPort(hostPort: number): number {
  return hostPort + AUTH_PROXY_PORT_OFFSET;
}

function authProxyScript(appName: string, password: string, appPort: number, listenPort: number, bindHost: string): string {
  // HMAC-based cookie signing. Cookie = timestamp.signature
  return `const PASSWORD = ${JSON.stringify(password)};
const UPSTREAM = "http://${bindHost}:${appPort}";
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
  hostname: "${bindHost}",
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
  bindHost: string,
  hostKey?: string
): Promise<number> {
  const listenPort = authProxyPort(appPort);
  log("auth", `Deploying auth proxy for ${appName}: proxy=${bindHost}:${listenPort} -> app=${bindHost}:${appPort}`);

  // Ensure Bun is available and executable by the deploy user
  const bunCheck = await sshExec(ip, "su - deploy -c '/usr/local/bin/bun --version' 2>/dev/null && echo ok || echo missing", hostKey);
  if (!bunCheck.stdout.includes("ok")) {
    log("auth", "Installing Bun on server...");
    await sshExec(ip, "apt-get update -qq && apt-get install -y -qq unzip > /dev/null 2>&1", hostKey);
    const install = await sshExec(ip, "rm -f /usr/local/bin/bun && curl -fsSL https://bun.sh/install | bash && cp /root/.bun/bin/bun /usr/local/bin/bun && chmod 755 /usr/local/bin/bun", hostKey);
    if (install.exitCode !== 0) {
      throw new Error(describeFailure("Failed to install Bun runtime on server", install));
    }
  }

  const script = authProxyScript(appName, password, appPort, listenPort, bindHost);
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
    const tail = logs.stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    throw new Error(`Auth proxy failed to start: ${tail || "service not active"}`);
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
