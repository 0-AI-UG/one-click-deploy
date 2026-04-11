// Caddy upstream manager — owns the panel server's Caddy admin API for every
// deployed app. Given an app id, computes the desired routes + upstream list
// (driven by the replicas table) and PUTs them to `http://localhost:2019` on
// the panel server via SSH. Reloads are atomic.
//
// Two Caddy HTTP servers live on the panel:
//
//   srv0          — listens on :80 and :443 for public ingress, auto-HTTPS
//                   enabled, one route per app matching the public domain.
//   srv_internal  — listens on :8080 on every interface, auto-HTTPS disabled,
//                   one route per app matching `<app>.ocd.internal`. Port
//                   8080 is deliberately *not* whitelisted in the Hetzner
//                   firewall — private-network traffic bypasses the firewall,
//                   public-network traffic is dropped at the edge, so this
//                   listener is effectively private without any extra config.
//
// All upstreams are reached via the shared Hetzner private network, so
// traffic between Caddy and the backends never touches the public internet.

import * as db from "../db.ts";
import { sshExec, authProxyPort } from "../remote/index.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [caddy-mgr:${context}]`, ...args);
}

/** Port exposed on the panel's private interface for app-to-app traffic. */
export const INTERNAL_PORT = 8080;

type CaddyUpstream = { dial: string };

type CaddyHandler = {
  handler: string;
  upstreams?: CaddyUpstream[];
  headers?: Record<string, unknown>;
  response?: {
    set?: Record<string, string[]>;
    deferred?: boolean;
  };
};

type CaddyRoute = {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: CaddyHandler[];
  terminal: boolean;
};

export type PanelAccess = {
  ipv4: string;
  privateIpv4: string;
  hostKey: string | undefined;
};

function publicRouteId(appName: string): string {
  return `ocd-app-${appName}`;
}

function internalRouteId(appName: string): string {
  return `ocd-internal-${appName}`;
}

function internalHost(appName: string): string {
  return `${appName}.ocd.internal`;
}

/**
 * Stable URL an app can use to reach another app over the panel's internal
 * HTTP ingress. Callers should use this in env vars / service discovery.
 */
export function internalAppUrl(appName: string): string {
  return `http://${internalHost(appName)}:${INTERNAL_PORT}`;
}

function getPanelAccess(): PanelAccess | null {
  const panel = db.getPanel();
  if (!panel) return null;
  const panelServer = db.getServer(panel.server_id);
  if (!panelServer || !panelServer.ipv4) return null;
  return {
    ipv4: panelServer.ipv4,
    privateIpv4: panelServer.private_ipv4 || "",
    hostKey: panelServer.ssh_host_key || undefined,
  };
}

async function persistCaddyConfig(panel: PanelAccess): Promise<void> {
  const result = await sshExec(
    panel.ipv4,
    `curl -sf http://localhost:2019/config/ | tee /etc/caddy/caddy.json > /dev/null`,
    panel.hostKey,
  );
  if (result.exitCode !== 0) {
    log("persist", `Warning: failed to persist Caddy config: ${result.stderr}`);
  }
}

function buildUpstreams(
  appId: number,
  authPassword: string,
): CaddyUpstream[] {
  const replicas = db.getReplicas(appId).filter((r) => r.status !== "stopped");
  const ups: CaddyUpstream[] = [];
  for (const replica of replicas) {
    const server = db.getServer(replica.server_id);
    if (!server) continue;
    // Prefer the private IP, fall back to public during the reconciler's
    // backfill window. Without *some* address we'd write an empty upstream
    // pool and Caddy would 503 every request.
    const addr = server.private_ipv4 || server.ipv4;
    if (!addr) continue;
    const destPort = authPassword
      ? authProxyPort(replica.host_port)
      : replica.host_port;
    ups.push({ dial: `${addr}:${destPort}` });
  }
  return ups;
}

function buildPublicRoute(
  appName: string,
  publicDomain: string,
  upstreams: CaddyUpstream[],
): CaddyRoute {
  return {
    "@id": publicRouteId(appName),
    match: [{ host: [publicDomain] }],
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
      {
        handler: "reverse_proxy",
        upstreams,
      },
    ],
    terminal: true,
  };
}

function buildInternalRoute(
  appName: string,
  upstreams: CaddyUpstream[],
): CaddyRoute {
  return {
    "@id": internalRouteId(appName),
    match: [{ host: [internalHost(appName)] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams,
      },
    ],
    terminal: true,
  };
}

/**
 * Ensure the `srv_internal` HTTP server exists in Caddy's config. Called at
 * the top of every syncAppCaddy run — it's a PUT against a fixed path, so
 * repeated calls are no-ops unless the server was missing.
 *
 * We only create the server when it doesn't exist (checked via GET). A
 * blanket PUT would wipe the `routes` array on every sync, which would race
 * with other apps' routes already installed under `srv_internal`.
 */
async function ensureInternalServer(panel: PanelAccess): Promise<void> {
  const check = await sshExec(
    panel.ipv4,
    `curl -sf -o /dev/null -w '%{http_code}' http://localhost:2019/config/apps/http/servers/srv_internal`,
    panel.hostKey,
  );
  // 200 → exists; 404 → missing. Caddy returns "null" with a 200 for missing
  // config paths under /config/…, so also treat an empty body as missing.
  const body = check.stdout.trim();
  if (body === "200") {
    const getBody = await sshExec(
      panel.ipv4,
      `curl -sf http://localhost:2019/config/apps/http/servers/srv_internal`,
      panel.hostKey,
    );
    if (getBody.stdout.trim() !== "null" && getBody.stdout.trim() !== "") {
      return;
    }
  }

  log("internal", "Creating srv_internal server on :8080");
  const serverConfig = {
    listen: [`:${INTERNAL_PORT}`],
    automatic_https: { disable: true, disable_redirects: true },
    routes: [] as CaddyRoute[],
  };
  const json = JSON.stringify(serverConfig).replace(/'/g, "'\\''");
  const put = await sshExec(
    panel.ipv4,
    `curl -sf -X PUT -H 'Content-Type: application/json' -d '${json}' http://localhost:2019/config/apps/http/servers/srv_internal`,
    panel.hostKey,
  );
  if (put.exitCode !== 0) {
    throw new Error(
      `Failed to install srv_internal on panel Caddy: ${put.stderr}`,
    );
  }
}

async function upsertRoute(
  panel: PanelAccess,
  serverName: "srv0" | "srv_internal",
  route: CaddyRoute,
): Promise<void> {
  const id = route["@id"];
  const routeJson = JSON.stringify(route).replace(/'/g, "'\\''");

  // Delete-then-POST is the least surprising way to upsert an @id-keyed
  // route against the admin API — PATCH /id/<id> silently appends a second
  // copy on mismatched paths.
  await sshExec(
    panel.ipv4,
    `curl -sf -X DELETE http://localhost:2019/id/${id} 2>/dev/null || true`,
    panel.hostKey,
  );
  const add = await sshExec(
    panel.ipv4,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${routeJson}' http://localhost:2019/config/apps/http/servers/${serverName}/routes`,
    panel.hostKey,
  );
  if (add.exitCode !== 0) {
    // Fallback: restart Caddy (loads the persisted caddy.json) and retry.
    log("upsert", `route POST failed, restarting Caddy: ${add.stderr}`);
    await sshExec(panel.ipv4, "systemctl restart caddy", panel.hostKey);
    await Bun.sleep(1000);
    await sshExec(
      panel.ipv4,
      `curl -sf -X DELETE http://localhost:2019/id/${id} 2>/dev/null || true`,
      panel.hostKey,
    );
    const retry = await sshExec(
      panel.ipv4,
      `curl -sf -X POST -H 'Content-Type: application/json' -d '${routeJson}' http://localhost:2019/config/apps/http/servers/${serverName}/routes`,
      panel.hostKey,
    );
    if (retry.exitCode !== 0) {
      throw new Error(
        `Failed to PUT Caddy route ${id} on ${serverName}: ${retry.stderr || add.stderr}`,
      );
    }
  }
}

async function ensureNipIoTlsPolicy(
  panel: PanelAccess,
  domain: string,
): Promise<void> {
  // nip.io domains can't get Let's Encrypt certs — use the internal issuer
  // so visitors get a (self-signed) cert instead of a handshake error.
  const policyId = `ocd-nipio-${domain.replace(/\./g, "-")}`;
  const policy = {
    "@id": policyId,
    subjects: [domain],
    issuers: [{ module: "internal" }],
  };
  const policyJson = JSON.stringify(policy).replace(/'/g, "'\\''");
  await sshExec(
    panel.ipv4,
    `curl -sf -X DELETE http://localhost:2019/id/${policyId} 2>/dev/null || true`,
    panel.hostKey,
  );
  const add = await sshExec(
    panel.ipv4,
    `curl -sf -X POST -H 'Content-Type: application/json' -d '${policyJson}' http://localhost:2019/config/apps/tls/automation/policies`,
    panel.hostKey,
  );
  if (add.exitCode !== 0) {
    const putJson = JSON.stringify([policy]).replace(/'/g, "'\\''");
    await sshExec(
      panel.ipv4,
      `curl -sf -X PUT -H 'Content-Type: application/json' -d '${putJson}' http://localhost:2019/config/apps/tls/automation/policies`,
      panel.hostKey,
    );
  }
}

/**
 * Write (or rewrite) both the public and internal Caddy vhosts for the
 * given app based on the current replicas in the DB. Idempotent — safe to
 * call on every lifecycle event.
 */
export async function syncAppCaddy(appId: number): Promise<void> {
  const app = db.getApp(appId);
  if (!app) return;

  const panel = getPanelAccess();
  if (!panel) {
    log("sync", `app ${appId}: no panel configured, skipping`);
    return;
  }

  const upstreams = buildUpstreams(appId, app.auth_password);
  if (upstreams.length === 0) {
    log("sync", `app ${appId}: no upstreams available — removing routes`);
    await removeAppCaddy(app.name, app.domain);
    return;
  }

  log(
    "sync",
    `app ${appId} (${app.name}) domain=${app.domain} upstreams=${upstreams.map((u) => u.dial).join(",")}`,
  );

  await ensureInternalServer(panel);

  await upsertRoute(panel, "srv0", buildPublicRoute(app.name, app.domain, upstreams));
  await upsertRoute(panel, "srv_internal", buildInternalRoute(app.name, upstreams));

  if (app.domain && app.domain.endsWith(".nip.io")) {
    await ensureNipIoTlsPolicy(panel, app.domain);
  }
  await persistCaddyConfig(panel);
}

/**
 * Remove both the public and internal Caddy routes for this app. Best-effort
 * — a missing route is treated as success so callers can run this on every
 * teardown without worrying about first-time vs. rerun.
 */
export async function removeAppCaddy(
  appName: string,
  _appDomain: string,
): Promise<void> {
  const panel = getPanelAccess();
  if (!panel) return;
  for (const id of [publicRouteId(appName), internalRouteId(appName)]) {
    await sshExec(
      panel.ipv4,
      `curl -sf -X DELETE http://localhost:2019/id/${id} 2>/dev/null || true`,
      panel.hostKey,
    );
  }
  await persistCaddyConfig(panel);
  log("remove", `app ${appName}: routes removed from panel Caddy`);
}

/** Check whether the app's public route is registered with the panel Caddy. */
export async function checkAppCaddyRoute(appName: string): Promise<boolean> {
  const panel = getPanelAccess();
  if (!panel) return false;
  const id = publicRouteId(appName);
  const result = await sshExec(
    panel.ipv4,
    `curl -sf http://localhost:2019/id/${id} > /dev/null`,
    panel.hostKey,
  );
  return result.exitCode === 0;
}
