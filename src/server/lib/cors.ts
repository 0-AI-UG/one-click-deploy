// Same-origin by default. Set CORS_ORIGIN to an explicit origin (or "*" only
// if you really need it) to enable cross-origin API access.
import { VERSION } from "../../shared/version.ts";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "";
const IS_PROD = process.env.NODE_ENV === "production";

const corsOriginHeaders: Record<string, string> = CORS_ORIGIN
  ? {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    }
  : {};

// Baseline security headers applied to every response. These are safe on both
// API (JSON) and HTML responses; browsers only enforce the HTML-relevant ones
// on document responses.
export const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Lets the CLI (and other clients) detect the backend version from any
  // response so it can warn when the CLI is behind. See src/cli/api.ts.
  "X-OCD-Version": VERSION,
  ...(IS_PROD
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : {}),
};

// Content-Security-Policy only makes sense on HTML document responses, and a
// strict policy would break Bun's dev HMR client. Applied separately in the
// static-serving path (see src/server/index.ts).
// NOTE: src/web/index.html currently pulls Tailwind from cdn.tailwindcss.com
// and Google Fonts, and has an inline <script> for tailwind.config. Until we
// self-host both, the CSP must allow those origins and 'unsafe-inline' on
// scripts. Tighten this when we move to a built CSS pipeline.
export const htmlCsp =
  "default-src 'self'; " +
  "img-src 'self' data: blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://esm.sh; " +
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://esm.sh; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' ws: wss:; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "object-src 'none'; " +
  "form-action 'self'";

export const corsHeaders: Record<string, string> = {
  ...corsOriginHeaders,
  ...securityHeaders,
};
