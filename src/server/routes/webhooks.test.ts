// Set tmp data dir BEFORE importing db.ts
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the engine enqueue so we never actually schedule any op.
const fakeRunner = mock((kind: string, input: Record<string, unknown>, idempotencyKey: string) => {
  void kind; void input; void idempotencyKey;
  return { opId: 1 };
});
mock.module("../ipc/enqueue.ts", () => ({
  enqueue: (args: {
    kind: string;
    input: Record<string, unknown>;
    triggeredBy: string;
    idempotencyKey?: string;
  }) => {
    fakeRunner(args.kind, args.input, args.idempotencyKey || "");
    return { opId: 1 };
  },
}));

const fakePanelRunner = mock(async (_opts?: any) => ({ ok: true }));
mock.module("../../engine/deploy/panel.ts", () => ({
  redeployPanel: (_p: any, opts: any) => fakePanelRunner(opts),
}));

import * as db from "../../shared/db.ts";
import {
  handleGithubWebhook,
  handlePanelGithubWebhook,
  normalizeWebhookPath,
  pushTouchesPath,
  verifyGithubSignature,
} from "./webhooks.ts";

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeApp(secret: string, branch = "main") {
  const app = db.insertApp({
    name: `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    domain: "x.example.com",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
  db.updateAppWebhook(app.id, true, secret, branch, "gh-1");
  return app;
}

function setupPanel(secret: string) {
  // Wipe any prior panel + server rows so each test starts clean.
  try { (db as any).deletePanel?.(); } catch { /* deletePanel may not exist in all DB versions */ }
  // Insert a fresh server + panel pointing at it.
  const srv = db.insertServer({
    name: `panel-host-${Date.now()}`,
    provider_id: `h-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  db.insertPanel({
    server_id: srv.id,
    name: "ocd-panel",
    domain: "panel.example.com",
    git_repo: "https://github.com/x/one-click-deploy",
    git_branch: "main",
    container_port: 3001,
    host_port: 3001,
  });
  db.updatePanelWebhook(true, secret, "gh-panel-1");
}

function panelReq(body: string, sig: string): Request {
  return new Request("http://localhost/webhooks/github/panel", {
    method: "POST",
    headers: { "x-hub-signature-256": sig },
    body,
  });
}

function req(appId: number, body: string, sig: string): Request {
  return new Request(`http://localhost/webhooks/github/${appId}`, {
    method: "POST",
    headers: { "x-hub-signature-256": sig },
    body,
  });
}

describe("handleGithubWebhook", () => {
  beforeEach(() => {
    fakeRunner.mockClear();
  });

  test("rejects an invalid signature with 401", async () => {
    const app = makeApp("secret-a");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "abc1234" });
    const res = await handleGithubWebhook(req(app.id, body, "sha256=deadbeef"), app.id);
    expect(res.status).toBe(401);
    expect(fakeRunner).not.toHaveBeenCalled();
  });

  test("returns 204 on non-matching branch", async () => {
    const secret = "secret-b";
    const app = makeApp(secret, "main");
    const body = JSON.stringify({ ref: "refs/heads/dev", after: "abc1234" });
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(204);
    expect(fakeRunner).not.toHaveBeenCalled();
  });

  test("persists and enqueues one stack reconciliation on a valid push", async () => {
    const secret = "secret-c";
    const app = makeApp(secret, "main");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "deadbee1234" });
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(202);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(fakeRunner.mock.calls[0][0]).toBe("webhook_reconcile_stack");
    expect(fakeRunner.mock.calls[0][1]).toMatchObject({ candidateId: expect.any(Number) });
  });

  test("uses the same app-and-commit key for distinct GitHub deliveries", async () => {
    const secret = "secret-dedupe";
    const app = makeApp(secret, "main");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "1234567890abcdef" });
    const sig = await sign(secret, body);
    const makeDelivery = (delivery: string) => new Request(
      `http://localhost/webhooks/github/${app.id}`,
      {
        method: "POST",
        headers: {
          "x-hub-signature-256": sig,
          "x-github-delivery": delivery,
        },
        body,
      },
    );

    expect((await handleGithubWebhook(makeDelivery("push-guid"), app.id)).status).toBe(202);
    expect((await handleGithubWebhook(makeDelivery("ci-guid"), app.id)).status).toBe(202);
    expect(fakeRunner).toHaveBeenCalledTimes(2);
    expect(fakeRunner.mock.calls[0][2]).toContain("webhook-candidate:");
    expect(fakeRunner.mock.calls[1][2]).toBe(fakeRunner.mock.calls[0][2]);
    expect(fakeRunner.mock.calls[1][1]).toEqual(fakeRunner.mock.calls[0][1]);
  });

  test("panel webhook: 401 on bad signature", async () => {
    fakePanelRunner.mockClear();
    setupPanel("panel-secret-a");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "abc1234" });
    const r = await handlePanelGithubWebhook(panelReq(body, "sha256=deadbeef"));
    expect(r.status).toBe(401);
    expect(fakePanelRunner).not.toHaveBeenCalled();
  });

  test("panel webhook: 204 on branch mismatch", async () => {
    fakePanelRunner.mockClear();
    const secret = "panel-secret-b";
    setupPanel(secret);
    const body = JSON.stringify({ ref: "refs/heads/dev", after: "abc1234" });
    const sig = await sign(secret, body);
    const r = await handlePanelGithubWebhook(panelReq(body, sig));
    expect(r.status).toBe(204);
    expect(fakePanelRunner).not.toHaveBeenCalled();
  });

  test("panel webhook: 202 dispatches detached redeploy on a valid push", async () => {
    fakePanelRunner.mockClear();
    const secret = "panel-secret-c";
    setupPanel(secret);
    const body = JSON.stringify({ ref: "refs/heads/main", after: "deadbee9999" });
    const sig = await sign(secret, body);
    const r = await handlePanelGithubWebhook(panelReq(body, sig));
    expect(r.status).toBe(202);
    // Allow the detached promise to schedule.
    await Bun.sleep(10);
    expect(fakePanelRunner).toHaveBeenCalledTimes(1);
    expect(fakePanelRunner.mock.calls[0][0]).toMatchObject({
      source: "webhook",
      gitCommit: "deadbee",
    });
  });

  test("404 when webhook is not enabled for the app", async () => {
    const app = db.insertApp({
      name: `noWebhook-${Date.now()}`,
      domain: "x.example.com",
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await handleGithubWebhook(req(app.id, body, "sha256=00"), app.id);
    expect(res.status).toBe(404);
  });

  test("404 for an unknown app id", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await handleGithubWebhook(req(999999, body, "sha256=00"), 999999);
    expect(res.status).toBe(404);
  });

  test("400 on malformed JSON payload (after valid signature)", async () => {
    const secret = "secret-json";
    const app = makeApp(secret, "main");
    const body = "not-json-at-all";
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(400);
    expect(fakeRunner).not.toHaveBeenCalled();
  });

  test("defers path filtering until the candidate becomes eligible", async () => {
    const secret = "secret-path";
    const app = makeApp(secret, "main");
    db.updateAppWebhook(app.id, true, secret, "main", "gh-1", "services/api");
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "abcdef1",
      commits: [{ modified: ["docs/readme.md"], added: [], removed: [] }],
    });
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(202);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(fakeRunner.mock.calls[0][0]).toBe("webhook_reconcile_stack");
  });

  test("202 when path filter matches at least one file", async () => {
    const secret = "secret-path2";
    const app = makeApp(secret, "main");
    db.updateAppWebhook(app.id, true, secret, "main", "gh-1", "services/api");
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "abcdef2",
      commits: [{ modified: ["services/api/server.ts"] }],
    });
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(202);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(fakeRunner.mock.calls[0][0]).toBe("webhook_reconcile_stack");
  });

  test("signature header of wrong length fails in constant time (no throw)", async () => {
    const app = makeApp("any-secret");
    const body = JSON.stringify({ ref: "refs/heads/main" });
    // Length differs from a real sha256= header → verifyGithubSignature
    // short-circuits on length mismatch rather than throwing.
    const res = await handleGithubWebhook(req(app.id, body, "sha256=ab"), app.id);
    expect(res.status).toBe(401);
  });

  test("signature header entirely missing is rejected", async () => {
    const app = makeApp("secret-missing-sig");
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const r = new Request(`http://localhost/webhooks/github/${app.id}`, {
      method: "POST",
      headers: {},
      body,
    });
    const res = await handleGithubWebhook(r, app.id);
    expect(res.status).toBe(401);
  });
});

describe("normalizeWebhookPath", () => {
  test("strips leading/trailing slashes", () => {
    expect(normalizeWebhookPath("/services/api/")).toBe("services/api");
    expect(normalizeWebhookPath("///x///")).toBe("x");
  });

  test("trims whitespace", () => {
    expect(normalizeWebhookPath("  services/api  ")).toBe("services/api");
  });

  test("empty becomes empty", () => {
    expect(normalizeWebhookPath("")).toBe("");
    expect(normalizeWebhookPath("///")).toBe("");
    expect(normalizeWebhookPath("   ")).toBe("");
  });

  test("leaves internal slashes alone", () => {
    expect(normalizeWebhookPath("a/b/c")).toBe("a/b/c");
  });
});

describe("pushTouchesPath", () => {
  test("empty prefix matches anything (no-filter semantics)", () => {
    expect(pushTouchesPath({ commits: [{ added: ["any.ts"] }] }, "")).toBe(true);
    expect(pushTouchesPath({}, "")).toBe(true);
  });

  test("matches exact file path equal to prefix", () => {
    expect(pushTouchesPath({ commits: [{ modified: ["services/api"] }] }, "services/api")).toBe(true);
  });

  test("matches files under the prefix", () => {
    expect(
      pushTouchesPath({ commits: [{ added: ["services/api/server.ts"] }] }, "services/api"),
    ).toBe(true);
  });

  test("rejects sibling prefixes (prefix + '/' guard, not raw startsWith)", () => {
    expect(
      pushTouchesPath({ commits: [{ added: ["services/api-v2/server.ts"] }] }, "services/api"),
    ).toBe(false);
  });

  test("scans added / modified / removed lists", () => {
    expect(pushTouchesPath({ commits: [{ removed: ["app/foo"] }] }, "app")).toBe(true);
    expect(pushTouchesPath({ commits: [{ modified: ["app/foo"] }] }, "app")).toBe(true);
    expect(pushTouchesPath({ commits: [{ added: ["app/foo"] }] }, "app")).toBe(true);
  });

  test("returns false when no commits present and filter non-empty", () => {
    expect(pushTouchesPath({}, "x")).toBe(false);
    expect(pushTouchesPath({ commits: [] }, "x")).toBe(false);
  });

  test("tolerates malformed commit entries", () => {
    // Non-array file lists, non-string entries.
    const payload = {
      commits: [
        { added: null as unknown as string[] },
        { modified: [42 as unknown as string, "valid/path"] },
      ],
    };
    expect(pushTouchesPath(payload, "valid")).toBe(true);
    expect(pushTouchesPath(payload, "other")).toBe(false);
  });
});

describe("verifyGithubSignature", () => {
  test("accepts a correctly-computed signature", async () => {
    const secret = "abc";
    const body = "hello";
    const sig = await sign(secret, body);
    expect(await verifyGithubSignature(body, secret, sig)).toBe(true);
  });

  test("rejects signature computed with a different secret", async () => {
    const body = "hello";
    const sig = await sign("wrong-secret", body);
    expect(await verifyGithubSignature(body, "right-secret", sig)).toBe(false);
  });

  test("rejects on body tampering", async () => {
    const secret = "k";
    const sig = await sign(secret, "original");
    expect(await verifyGithubSignature("modified", secret, sig)).toBe(false);
  });

  test("length mismatch short-circuits without throwing", async () => {
    expect(await verifyGithubSignature("x", "k", "sha256=short")).toBe(false);
    expect(await verifyGithubSignature("x", "k", "")).toBe(false);
  });
});
