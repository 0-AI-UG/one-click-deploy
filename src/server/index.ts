import path from "path";
import { corsHeaders, securityHeaders, htmlCsp } from "./lib/cors.ts";
import { tryTerminalUpgrade, terminalWsHandlers } from "./routes/terminal.ts";
import { apiRoutes } from "./routes.ts";
import { startEngineInProcess } from "../engine/entrypoint.ts";

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
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...securityHeaders,
  };
  // CSP only on HTML documents, and only in prod — dev HMR needs looser rules.
  if (ext === ".html" && IS_PROD) {
    headers["Content-Security-Policy"] = htmlCsp;
  }
  if (/[-\.][a-z0-9]{8,}\.\w+$/.test(filePath)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return new Response(file, { headers });
}

// In dev, use Bun's HTML import for HMR
let devIndex: Bun.HTMLBundle | null = null;
if (!IS_PROD) {
  devIndex = (await import("../web/index.html")).default;
}

// ── Headless auto-deploy mode ──
// When OCD_AUTO_DEPLOY is set, run the self-deploy pipeline and exit
// without ever binding the HTTP server. Used by the Docker one-liner.
if (process.env.OCD_AUTO_DEPLOY) {
  const { loadAutoDeployConfig, runAutoDeploy } = await import("../engine/auto-deploy.ts");
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
    ...apiRoutes,
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

// Start the operation engine in-process unless disabled (for running a
// dedicated engine process, set OCD_ENGINE=0 on the server and run
// `bun run engine` separately).
if (process.env.OCD_ENGINE !== "0") {
  startEngineInProcess();
}
