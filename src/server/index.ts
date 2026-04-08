import path from "path";
import { corsHeaders } from "./lib/cors.ts";
import { handleSetupStatus, handleSetupComplete, handleSetupServerTypes } from "./routes/setup.ts";
import { handleLogin, handleMe, handleUpdateMe } from "./routes/auth.ts";
import {
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpLogin,
  handleTotpSetupFromLogin,
  handleTotpConfirmFromLogin,
  handleTotpDisable,
  handleTotpStatus,
} from "./routes/totp.ts";
import { handleListUsers, handleCreateUser, handleUpdateUser, handleDeleteUser, handleGetUserPermissions } from "./routes/admin.ts";
import {
  handleGetServers,
  handleGetApps,
  handleDeploy,
  handleDeployStream,
  handleDestroyApp,
  handleRestartApp,
  handlePauseApp,
  handleUnpauseApp,
  handleRedeployApp,
  handleUpdateAppEnv,
  handleGetContainerLogs,
  handleGetDeployLog,
  handleGetDeployments,
  handleRollbackApp,
} from "./routes/apps.ts";
import { handleDeleteServer, handleRefreshServers } from "./routes/servers.ts";
import { handleGetSettings, handleSaveSettings, handleGetServerTypes, handleExportSshKey, handleImportSshKey } from "./routes/settings.ts";
import { handleGetResources, handleDeleteResource } from "./routes/resources.ts";
import { handleAttachVolume, handleAttachExistingVolume, handleDetachVolume, handleReattachVolume, handleResizeVolume } from "./routes/volumes.ts";
import { handleScaleApp, handleUpdateScalingPolicy, handleGetReplicas, handleGetScalingEvents, handleGetAppMetrics, handleGetAppMetricsHistory } from "./routes/scaling.ts";
import { handleEnableWebhook, handleDisableWebhook } from "./routes/webhooks.ts";
import { startReconciler } from "../bun/reconciler.ts";
import { tryTerminalUpgrade, terminalWsHandlers } from "./routes/terminal.ts";

const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PROD = process.env.NODE_ENV === "production";
const WEB_DIST = path.resolve(import.meta.dir, "../web/dist");

// ── Frontend serving ──
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (/[-\.][a-z0-9]{8,}\.\w+$/.test(filePath)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return new Response(file, { headers });
}

// In dev, use Bun's HTML import for HMR
let devIndex: any = null;
if (!IS_PROD) {
  devIndex = (await import("../web/index.html")).default;
}

// ── Helpers for route param extraction ──
function appIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/apps\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function userIdFrom(req: Request): string {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/admin\/users\/([^/]+)/);
  return match ? match[1] : "";
}

function serverIdFrom(req: Request): number {
  const url = new URL(req.url);
  return parseInt(url.pathname.split("/").pop()!, 10);
}

function resourcePartsFrom(req: Request): { type: string; id: string } {
  const parts = new URL(req.url).pathname.split("/");
  return { type: parts[3], id: parts[4] };
}

// ── Headless auto-deploy mode ──
// When OCD_AUTO_DEPLOY is set, run the self-deploy pipeline and exit
// without ever binding the HTTP server. Used by the Docker one-liner.
if (process.env.OCD_AUTO_DEPLOY) {
  const { loadAutoDeployConfig, runAutoDeploy } = await import("../bun/auto-deploy.ts");
  try {
    const config = loadAutoDeployConfig(process.env.OCD_AUTO_DEPLOY);
    const result = await runAutoDeploy(config);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error("[auto-deploy] Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ── Server ──
export const server = Bun.serve({
  port: PORT,
  routes: {
    // --- Setup ---
    "/api/setup/status": { GET: (req: Request) => handleSetupStatus(req) },
    "/api/setup/complete": { POST: (req: Request) => handleSetupComplete(req) },
    "/api/setup/server-types": { POST: (req: Request) => handleSetupServerTypes(req) },

    // --- Auth ---
    "/api/auth/login": { POST: (req: Request) => handleLogin(req) },
    "/api/me": {
      GET: (req: Request) => handleMe(req),
      PUT: (req: Request) => handleUpdateMe(req),
    },

    // --- TOTP ---
    "/api/auth/totp/setup": { POST: (req: Request) => handleTotpSetup(req) },
    "/api/auth/totp/confirm": { POST: (req: Request) => handleTotpConfirm(req) },
    "/api/auth/totp/login": { POST: (req: Request) => handleTotpLogin(req) },
    "/api/auth/totp/setup-from-login": { POST: (req: Request) => handleTotpSetupFromLogin(req) },
    "/api/auth/totp/confirm-from-login": { POST: (req: Request) => handleTotpConfirmFromLogin(req) },
    "/api/auth/totp/disable": { POST: (req: Request) => handleTotpDisable(req) },
    "/api/auth/totp/status": { GET: (req: Request) => handleTotpStatus(req) },

    // --- Admin ---
    "/api/admin/users": {
      GET: (req: Request) => handleListUsers(req),
      POST: (req: Request) => handleCreateUser(req),
    },
    "/api/admin/users/:userId": {
      PUT: (req: Request) => handleUpdateUser(req, userIdFrom(req)),
      DELETE: (req: Request) => handleDeleteUser(req, userIdFrom(req)),
    },
    "/api/admin/users/:userId/permissions": {
      GET: (req: Request) => handleGetUserPermissions(req, userIdFrom(req)),
    },

    // --- Servers ---
    "/api/servers": { GET: (req: Request) => handleGetServers(req) },
    "/api/servers/refresh": { POST: (req: Request) => handleRefreshServers(req) },
    "/api/servers/:id": { DELETE: (req: Request) => handleDeleteServer(req, serverIdFrom(req)) },

    // --- Apps ---
    "/api/apps": { GET: (req: Request) => handleGetApps(req) },
    "/api/apps/deploy": { POST: (req: Request) => handleDeploy(req) },

    // App-specific
    "/api/apps/:appId": { DELETE: (req: Request) => handleDestroyApp(req, appIdFrom(req)) },
    "/api/apps/:appId/restart": { POST: (req: Request) => handleRestartApp(req, appIdFrom(req)) },
    "/api/apps/:appId/pause": { POST: (req: Request) => handlePauseApp(req, appIdFrom(req)) },
    "/api/apps/:appId/unpause": { POST: (req: Request) => handleUnpauseApp(req, appIdFrom(req)) },
    "/api/apps/:appId/redeploy": { POST: (req: Request) => handleRedeployApp(req, appIdFrom(req)) },
    "/api/apps/:appId/env": { PUT: (req: Request) => handleUpdateAppEnv(req, appIdFrom(req)) },
    "/api/apps/:appId/logs": { GET: (req: Request) => handleGetContainerLogs(req, appIdFrom(req)) },
    "/api/apps/:appId/deploy-log": { GET: (req: Request) => handleGetDeployLog(req, appIdFrom(req)) },
    "/api/apps/:appId/deployments": { GET: (req: Request) => handleGetDeployments(req, appIdFrom(req)) },
    "/api/apps/:appId/rollback": { POST: (req: Request) => handleRollbackApp(req, appIdFrom(req)) },
    "/api/apps/:appId/deploy/stream": { GET: (req: Request) => {
      const name = new URL(req.url).pathname.split("/")[3];
      return handleDeployStream(req, name);
    }},

    // Scaling
    "/api/apps/:appId/scale": { POST: (req: Request) => handleScaleApp(req, appIdFrom(req)) },
    "/api/apps/:appId/scaling-policy": { PUT: (req: Request) => handleUpdateScalingPolicy(req, appIdFrom(req)) },
    "/api/apps/:appId/replicas": { GET: (req: Request) => handleGetReplicas(req, appIdFrom(req)) },
    "/api/apps/:appId/scaling-events": { GET: (req: Request) => handleGetScalingEvents(req, appIdFrom(req)) },
    "/api/apps/:appId/metrics": { GET: (req: Request) => handleGetAppMetrics(req, appIdFrom(req)) },
    "/api/apps/:appId/metrics/history": { GET: (req: Request) => handleGetAppMetricsHistory(req, appIdFrom(req)) },

    // Webhooks
    "/api/apps/:appId/webhook/enable": { POST: (req: Request) => handleEnableWebhook(req, appIdFrom(req)) },
    "/api/apps/:appId/webhook/disable": { POST: (req: Request) => handleDisableWebhook(req, appIdFrom(req)) },

    // --- Settings ---
    "/api/settings": {
      GET: (req: Request) => handleGetSettings(req),
      PUT: (req: Request) => handleSaveSettings(req),
    },
    "/api/settings/server-types": { GET: (req: Request) => handleGetServerTypes(req) },
    "/api/settings/ssh-key/export": { GET: (req: Request) => handleExportSshKey(req) },
    "/api/settings/ssh-key/import": { POST: (req: Request) => handleImportSshKey(req) },

    // --- Resources ---
    "/api/resources": { GET: (req: Request) => handleGetResources(req) },
    "/api/resources/:type/:id": {
      DELETE: (req: Request) => {
        const { type, id } = resourcePartsFrom(req);
        return handleDeleteResource(req, type, id);
      },
    },

    // --- Volumes ---
    "/api/volumes/attach": { POST: (req: Request) => handleAttachVolume(req) },
    "/api/volumes/attach-existing": { POST: (req: Request) => handleAttachExistingVolume(req) },
    "/api/volumes/detach": { POST: (req: Request) => handleDetachVolume(req) },
    "/api/volumes/reattach": { POST: (req: Request) => handleReattachVolume(req) },
    "/api/volumes/resize": { POST: (req: Request) => handleResizeVolume(req) },

    // Frontend catch-all (dev mode only — prod uses fetch fallback)
    ...(!IS_PROD && devIndex ? { "/*": devIndex } : {}) as Record<string, never>,
  },

  async fetch(request, server) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Terminal WebSocket upgrade
    const termResult = await tryTerminalUpgrade(request, server);
    if (termResult === null) return undefined as unknown as Response;
    if (termResult !== "not-matched") return termResult;

    // API routes that weren't matched by routes{}
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    }

    // Production: serve frontend from web/dist/
    if (IS_PROD) {
      const filePath = path.join(WEB_DIST, url.pathname === "/" ? "index.html" : url.pathname);
      const staticRes = await serveStatic(filePath);
      if (staticRes) return staticRes;

      // SPA fallback
      return (await serveStatic(path.join(WEB_DIST, "index.html")))!;
    }

    // Dev: return undefined to let Bun's internal dev server handle /_bun/* etc.
    return undefined as unknown as Response;
  },

  development: !IS_PROD && {
    hmr: true,
    console: true,
  },

  websocket: terminalWsHandlers,
});

console.log(`[server] One-Click Deploy API running on http://localhost:${PORT}`);

startReconciler();
