import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { getOperation } from "../../shared/db/operations.ts";
import { handleGitHubBuildWebhook, verifyGitHubSignature } from "./build-webhooks.ts";

async function signature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function fixture() {
  const suffix = randomSuffix();
  const server = db.insertServer({ name: `webhook-${suffix}`, provider_id: `webhook-${suffix}`, ipv4: "203.0.113.40", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
  const worker = db.insertBuildWorker({ serverId: server.id, name: `worker-${suffix}`, previousPool: "general" });
  const source = db.upsertBuildSource({ repository: `https://github.com/acme/${suffix}.git`, branch: "main", workerId: worker.id });
  const secret = `secret-${suffix}-0123456789abcdef`;
  await secretStore.set(`build_source_webhook:${source.id}`, secret);
  return { source, secret };
}

function request(sourceId: number, body: string, sig: string, event = "push", delivery = "delivery-1") {
  return new Request(`https://panel.example.com/webhooks/github/build/${sourceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": sig,
    },
    body,
  });
}

describe("GitHub build webhook", () => {
  test("verifies HMAC without accepting malformed signatures", async () => {
    const body = '{"hello":"world"}';
    const sig = await signature(body, "correct-secret");
    expect(await verifyGitHubSignature(body, "correct-secret", sig)).toBe(true);
    expect(await verifyGitHubSignature(body, "wrong-secret", sig)).toBe(false);
    expect(await verifyGitHubSignature(body, "correct-secret", "sha256=bad")).toBe(false);
  });

  test("queues one idempotent exact-commit build for a valid push", async () => {
    const { source, secret } = await fixture();
    const commit = "a".repeat(40);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: commit,
      repository: { clone_url: source.repository },
    });
    const sig = await signature(body, secret);
    const first = await handleGitHubBuildWebhook(request(source.id, body, sig), source.id);
    const second = await handleGitHubBuildWebhook(request(source.id, body, sig, "push", "delivery-2"), source.id);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstId = Number((await first.text()).match(/#(\d+)/)?.[1]);
    const secondId = Number((await second.text()).match(/#(\d+)/)?.[1]);
    expect(secondId).toBe(firstId);
    const op = getOperation(firstId)!;
    expect(op.kind).toBe("webhook_build_source");
    expect(JSON.parse(op.input_json).commit).toBe(commit);
    expect(db.getBuildSourceDelivery(source.id, "delivery-2")?.status).toBe("duplicate");
    expect(db.getBuildSource(source.id)?.last_delivery_id).toBe("delivery-1");
  });

  test("supersedes and cancels an older queued delivery", async () => {
    const { source, secret } = await fixture();
    const olderBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "a".repeat(40),
      head_commit: { timestamp: "2026-08-30T10:00:00Z" },
      repository: { clone_url: source.repository },
    });
    const newerBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "b".repeat(40),
      head_commit: { timestamp: "2026-08-30T11:00:00Z" },
      repository: { clone_url: source.repository },
    });
    const olderResponse = await handleGitHubBuildWebhook(
      request(source.id, olderBody, await signature(olderBody, secret), "push", "delivery-old"),
      source.id,
    );
    const olderId = Number((await olderResponse.text()).match(/#(\d+)/)?.[1]);
    await handleGitHubBuildWebhook(
      request(source.id, newerBody, await signature(newerBody, secret), "push", "delivery-new"),
      source.id,
    );

    expect(getOperation(olderId)?.status).toBe("cancelled");
    expect(db.getBuildSourceDelivery(source.id, "delivery-old")?.status).toBe("superseded");
    expect(db.getBuildSourceDelivery(source.id, "delivery-new")?.status).toBe("queued");
    expect(db.getBuildSource(source.id)?.last_delivery_id).toBe("delivery-new");
  });

  test("records but does not enqueue a delivery older than the latest event", async () => {
    const { source, secret } = await fixture();
    const newerBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "c".repeat(40),
      head_commit: { timestamp: "2026-08-30T12:00:00Z" },
      repository: { clone_url: source.repository },
    });
    const staleBody = JSON.stringify({
      ref: "refs/heads/main",
      after: "d".repeat(40),
      head_commit: { timestamp: "2026-08-30T11:00:00Z" },
      repository: { clone_url: source.repository },
    });
    await handleGitHubBuildWebhook(
      request(source.id, newerBody, await signature(newerBody, secret), "push", "delivery-latest"),
      source.id,
    );
    const stale = await handleGitHubBuildWebhook(
      request(source.id, staleBody, await signature(staleBody, secret), "push", "delivery-stale"),
      source.id,
    );

    expect(stale.status).toBe(202);
    expect(await stale.text()).toContain("stale");
    expect(db.getBuildSourceDelivery(source.id, "delivery-stale")).toMatchObject({
      status: "stale",
      operation_id: null,
    });
    expect(db.getBuildSource(source.id)?.last_delivery_id).toBe("delivery-latest");
  });

  test("rejects bad signatures and ignores a different branch", async () => {
    const { source, secret } = await fixture();
    const body = JSON.stringify({
      ref: "refs/heads/feature",
      after: "b".repeat(40),
      repository: { clone_url: source.repository },
    });
    expect((await handleGitHubBuildWebhook(request(source.id, body, "sha256=" + "0".repeat(64)), source.id)).status).toBe(401);
    expect((await handleGitHubBuildWebhook(request(source.id, body, await signature(body, secret)), source.id)).status).toBe(204);
  });
});
