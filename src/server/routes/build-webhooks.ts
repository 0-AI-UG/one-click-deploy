import { timingSafeEqual } from "node:crypto";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { handleError } from "../lib/utils.ts";
import { getOperation, requestCancel } from "../../shared/db/operations.ts";

function canonicalRepository(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

export async function verifyGitHubSignature(raw: string, secret: string, header: string): Promise<boolean> {
  if (!/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = `sha256=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export async function handleGitHubBuildWebhook(request: Request, sourceId: number): Promise<Response> {
  try {
    const source = db.getBuildSource(sourceId);
    const secret = source ? await secretStore.get(`build_source_webhook:${source.id}`) : null;
    if (!source || !source.webhook_enabled || !secret) return new Response("Not found", { status: 404 });
    const raw = await request.text();
    if (!(await verifyGitHubSignature(raw, secret, request.headers.get("x-hub-signature-256") || ""))) {
      return new Response("Invalid signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event") || "";
    if (event === "ping") return new Response("pong", { status: 200 });
    if (event !== "push") return new Response("Ignored", { status: 204 });
    const payload = JSON.parse(raw) as {
      ref?: string;
      after?: string;
      head_commit?: { timestamp?: string } | null;
      repository?: { html_url?: string; clone_url?: string; pushed_at?: number };
    };
    if (payload.ref !== `refs/heads/${source.branch}`) return new Response("Branch mismatch", { status: 204 });
    const repository = payload.repository?.clone_url || payload.repository?.html_url || "";
    if (canonicalRepository(repository) !== canonicalRepository(source.repository)) {
      return new Response("Repository mismatch", { status: 400 });
    }
    const commit = String(payload.after || "");
    if (!/^[0-9a-f]{40,64}$/i.test(commit) || /^0+$/.test(commit)) return new Response("No deployable commit", { status: 204 });
    const delivery = request.headers.get("x-github-delivery") || `${source.id}:${commit}`;
    const timestamp = payload.head_commit?.timestamp ||
      (payload.repository?.pushed_at ? new Date(payload.repository.pushed_at * 1000).toISOString() : "");
    const eventAt = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
    const latest = db.getLatestBuildSourceDelivery(source.id);
    const recorded = db.recordBuildSourceDelivery({
      sourceId: source.id,
      deliveryId: delivery,
      commitSha: commit,
      eventAt,
    });
    if (!recorded.inserted && recorded.delivery.operation_id != null) {
      return new Response(`Accepted operation #${recorded.delivery.operation_id}`, { status: 202 });
    }
    if (latest && latest.delivery_id !== delivery && eventAt && latest.event_at &&
      Date.parse(eventAt) <= Date.parse(latest.event_at)) {
      db.updateBuildSourceDeliveryStatus({ sourceId: source.id, deliveryId: delivery, status: "stale" });
      db.compactBuildSourceDeliveries(source.id);
      return new Response("Ignored stale delivery", { status: 202 });
    }

    const { opId } = enqueue({
      kind: "webhook_build_source",
      resourceKeys: [`build-source:${source.id}`],
      input: { sourceId: source.id, commit, deliveryId: delivery },
      trigger: "webhook",
      triggeredBy: `github:${delivery}`,
      idempotencyKey: `webhook-build:${source.id}:${commit}`,
    });
    db.attachBuildSourceDeliveryOperation({ sourceId: source.id, deliveryId: delivery, operationId: opId });
    const operation = getOperation(opId);
    const operationInput = operation ? JSON.parse(operation.input_json || "{}") as { deliveryId?: string } : null;
    if (operationInput?.deliveryId && operationInput.deliveryId !== delivery) {
      db.updateBuildSourceDeliveryStatus({ sourceId: source.id, deliveryId: delivery, status: "duplicate" });
      db.compactBuildSourceDeliveries(source.id);
      return new Response(`Already queued as operation #${opId}`, { status: 202 });
    }
    if (operation && !["pending", "running", "compensating"].includes(operation.status)) {
      db.updateBuildSourceDeliveryStatus({ sourceId: source.id, deliveryId: delivery, status: "duplicate" });
      db.compactBuildSourceDeliveries(source.id);
      return new Response(`Already handled by operation #${opId}`, { status: 202 });
    }

    db.updateBuildSourceDelivery(source.id, {
      last_delivery_id: delivery,
      last_commit: commit,
      last_status: "queued",
      last_error: "",
      last_received_at: new Date().toISOString(),
    });

    if (eventAt) {
      for (const older of db.listActiveBuildSourceDeliveries(source.id)) {
        if (older.delivery_id === delivery || older.operation_id === opId || !older.event_at) continue;
        const isOlder = Date.parse(older.event_at) < Date.parse(eventAt) ||
          (older.event_at === eventAt && older.id < recorded.delivery.id);
        if (!isOlder) continue;
        db.updateBuildSourceDeliveryStatus({
          sourceId: source.id,
          deliveryId: older.delivery_id,
          status: "superseded",
          supersededByDeliveryId: delivery,
        });
        if (older.operation_id != null) requestCancel(older.operation_id);
      }
    }
    db.compactBuildSourceDeliveries(source.id);
    return new Response(`Accepted operation #${opId}`, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
