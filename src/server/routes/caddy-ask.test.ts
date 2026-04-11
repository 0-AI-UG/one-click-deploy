// Isolated DB for the Caddy on-demand-TLS ask endpoint tests.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-ask-test-"));

import { describe, test, expect, beforeEach } from "bun:test";

import * as db from "../../bun/db.ts";
import { handleCaddyAsk } from "./scaling.ts";

function freshApp(domain: string) {
  return db.insertApp({
    name: `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    domain,
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
}

function askFor(domain: string): Request {
  return new Request(`http://panel.example.com/api/caddy/ask?domain=${encodeURIComponent(domain)}`);
}

describe("handleCaddyAsk", () => {
  beforeEach(() => {
    // Clean up any apps from prior tests. deleteApp cascades to dns_records.
    const apps = db.getApps();
    for (const a of apps) db.deleteApp(a.id);
  });

  test("rejects missing domain param with 400", async () => {
    const res = await handleCaddyAsk(
      new Request("http://panel.example.com/api/caddy/ask"),
    );
    expect(res.status).toBe(400);
  });

  test("rejects unknown domain with 404 (no matching app)", async () => {
    const res = await handleCaddyAsk(askFor("ghost.example.com"));
    expect(res.status).toBe(404);
  });

  test("rejects known app whose wake page is NOT on the panel", async () => {
    const app = freshApp("norm.example.com");
    // Default state — wake_page_on_panel = 0. Even though the domain exists
    // in our DB, we refuse to mint a cert for it until the freeze worker
    // has actually moved its wake page onto the panel. This is the gate
    // that stops the panel from being abused as an ACME open relay for
    // every domain in our apps table.
    expect(db.getApp(app.id)?.wake_page_on_panel).toBe(0);
    const res = await handleCaddyAsk(askFor(app.domain));
    expect(res.status).toBe(404);
  });

  test("authorizes known app whose wake page IS on the panel", async () => {
    const app = freshApp("frozen.example.com");
    db.setAppWakePageOnPanel(app.id, true);
    const res = await handleCaddyAsk(askFor(app.domain));
    expect(res.status).toBe(200);
  });

  test("rejects nip.io domains outright (internal TLS path)", async () => {
    const app = freshApp("foo.1-2-3-4.nip.io");
    // Even setting the flag shouldn't matter — nip.io never goes through
    // on-demand ACME.
    db.setAppWakePageOnPanel(app.id, true);
    const res = await handleCaddyAsk(askFor(app.domain));
    expect(res.status).toBe(404);
  });

  test("rejects .localhost domains outright", async () => {
    const app = freshApp("foo.localhost");
    db.setAppWakePageOnPanel(app.id, true);
    const res = await handleCaddyAsk(askFor(app.domain));
    expect(res.status).toBe(404);
  });

  test("flipping the flag off de-authorizes future requests", async () => {
    const app = freshApp("toggle.example.com");
    db.setAppWakePageOnPanel(app.id, true);
    expect((await handleCaddyAsk(askFor(app.domain))).status).toBe(200);
    db.setAppWakePageOnPanel(app.id, false);
    expect((await handleCaddyAsk(askFor(app.domain))).status).toBe(404);
  });
});
