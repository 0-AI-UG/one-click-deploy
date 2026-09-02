import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { redeployPanel } from "../../engine/deploy/panel.ts";

export const PANEL_RELEASE_SECRET_KEY = "panel_release_webhook_secret";
export const PANEL_RELEASE_WEBHOOK_PATH = "/webhooks/github/panel-release";
export const PANEL_RELEASE_MAX_SKEW_SECONDS = 300;

const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;
const FULL_COMMIT = /^[a-f0-9]{40}$/i;
const MAX_BODY_BYTES = 4096;

function imageRepository(image: string): string {
  return image.split("@sha256:", 1)[0].toLowerCase();
}

export function signPanelRelease(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyPanelReleaseSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  supplied: string,
): boolean {
  const expected = Buffer.from(signPanelRelease(secret, timestamp, rawBody));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePanelRelease(
  body: { image?: unknown; commit?: unknown },
  currentImage: string,
): { valid: true; image: string; commit: string } | { valid: false; error: string } {
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const commit = typeof body.commit === "string" ? body.commit.trim().toLowerCase() : "";
  if (!IMMUTABLE_IMAGE.test(image)) {
    return { valid: false, error: "image must be an immutable OCI reference" };
  }
  if (!FULL_COMMIT.test(commit)) {
    return { valid: false, error: "commit must be a full 40-character Git SHA" };
  }
  if (!IMMUTABLE_IMAGE.test(currentImage) || imageRepository(image) !== imageRepository(currentImage)) {
    return { valid: false, error: "release image repository does not match the current panel" };
  }
  return { valid: true, image, commit };
}

/** Public, narrowly scoped release receiver called by GitHub Actions only
 * after the multi-architecture image has been published. The signature covers
 * both a short-lived timestamp and the exact raw JSON body. */
export async function handlePanelReleaseWebhook(request: Request): Promise<Response> {
  try {
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders });
    }

    const timestamp = request.headers.get("x-ocd-timestamp") || "";
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!/^\d{10}$/.test(timestamp) || Math.abs(nowSeconds - timestampSeconds) > PANEL_RELEASE_MAX_SKEW_SECONDS) {
      return Response.json({ error: "Expired release request" }, { status: 401, headers: corsHeaders });
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
      return Response.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders });
    }
    const secret = await secretStore.get(PANEL_RELEASE_SECRET_KEY);
    const signature = request.headers.get("x-ocd-signature-256") || "";
    if (!secret || !verifyPanelReleaseSignature(secret, timestamp, rawBody, signature)) {
      return Response.json({ error: "Invalid release signature" }, { status: 401, headers: corsHeaders });
    }

    let body: { image?: unknown; commit?: unknown };
    try {
      body = JSON.parse(rawBody) as { image?: unknown; commit?: unknown };
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400, headers: corsHeaders });
    }

    const panel = db.getPanel();
    if (!panel) return Response.json({ error: "Panel is not configured" }, { status: 409, headers: corsHeaders });
    const release = validatePanelRelease(body, panel.image_ref);
    if (!release.valid) {
      return Response.json({ error: release.error }, { status: 400, headers: corsHeaders });
    }
    if (panel.image_ref === release.image) {
      return Response.json({ ok: true, already_deployed: true }, { headers: corsHeaders });
    }

    const result = await redeployPanel(
      () => {},
      { image: release.image, commit: release.commit, source: "github-release" },
    );
    return Response.json(result, { status: result.ok ? 200 : 502, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelReleaseWebhook(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "panel.manage");
    return Response.json(
      {
        configured: !!(await secretStore.get(PANEL_RELEASE_SECRET_KEY)),
        webhook_url: new URL(PANEL_RELEASE_WEBHOOK_PATH, request.url).toString(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRotatePanelReleaseWebhook(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "panel.manage");
    const secret = randomBytes(32).toString("hex");
    await secretStore.set(PANEL_RELEASE_SECRET_KEY, secret);
    return Response.json(
      {
        configured: true,
        secret,
        webhook_url: new URL(PANEL_RELEASE_WEBHOOK_PATH, request.url).toString(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
