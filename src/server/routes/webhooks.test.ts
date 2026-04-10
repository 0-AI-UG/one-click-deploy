// Set tmp data dir BEFORE importing db.ts
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the redeploy worker so we never run any real SSH/build.
const fakeRunner = mock(async (_appId: number, _sha: string) => {});
mock.module("../../bun/deploy/redeploy.ts", () => ({
  enqueueWebhookRedeploy: (appId: number, sha: string) => fakeRunner(appId, sha),
}));

const fakePanelRunner = mock(async (_opts?: any) => ({ ok: true }));
mock.module("../../bun/deploy/panel.ts", () => ({
  redeployPanel: (_p: any, opts: any) => fakePanelRunner(opts),
}));

import * as db from "../../bun/db.ts";
import { handleGithubWebhook, handlePanelGithubWebhook } from "./webhooks.ts";

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
    hetzner_id: `h-${Date.now()}-${Math.random()}`,
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

  test("enqueues a redeploy on a valid push", async () => {
    const secret = "secret-c";
    const app = makeApp(secret, "main");
    const body = JSON.stringify({ ref: "refs/heads/main", after: "deadbee1234" });
    const sig = await sign(secret, body);
    const res = await handleGithubWebhook(req(app.id, body, sig), app.id);
    expect(res.status).toBe(202);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    expect(fakeRunner.mock.calls[0][0]).toBe(app.id);
    expect(fakeRunner.mock.calls[0][1]).toBe("deadbee");
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
});
