import { expect, test } from "bun:test";
import { seedTestAdmin, useTempDataDir } from "../../shared/test-helpers.ts";
import * as db from "../../shared/db.ts";
import { createToken } from "../lib/auth.ts";
import { createConfirmation, resolveConfirmation } from "../lib/action-confirm.ts";
import { handleCliActionRun } from "./web-cli.ts";
import { handleGetDeletedEnvironments, handlePurgeEnvironment } from "./environments.ts";

useTempDataDir();

test("CLI setup failures produce an error event", async () => {
  const token = await createToken({ userId: seedTestAdmin(), username: "test-admin" });
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = `${useTempDataDir()}/missing-parent`;
  try {
    const response = await handleCliActionRun(new Request("http://localhost/api/cli-actions/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: "envs.purge", values: { environment: "1" }, confirmed: true }),
    }));
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1).error).toContain("ENOENT");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
  }
});

test("browser CLI purge deletes a protected environment and streams an exit status", async () => {
  const user = { userId: seedTestAdmin(), username: "test-admin" };
  const token = await createToken(user);
  const environment = db.insertEnvironment("purge-stream-test", "{}");
  db.softDeleteEnvironment(environment.id);
  const confirmation = createConfirmation(user, "purge_environment", "environment", String(environment.id), "Purge test environment");
  resolveConfirmation(confirmation.userCode, user, "confirmed");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/cli-actions/run") return handleCliActionRun(request);
      if (url.pathname === "/api/environments/deleted") return handleGetDeletedEnvironments(request);
      if (url.pathname === `/api/environments/${environment.id}/purge`) return handlePurgeEnvironment(request, environment.id);
      return new Response("Not found", { status: 404 });
    },
  });
  const previousUrl = process.env.OCD_WEB_CLI_PANEL_URL;
  process.env.OCD_WEB_CLI_PANEL_URL = server.url.toString();
  try {
    const response = await fetch(new URL("/api/cli-actions/run", server.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: "envs.purge", values: { environment: String(environment.id) }, confirmed: true, confirmation_code: confirmation.confirmCode }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
    expect(db.getDeletedEnvironment(environment.id)).toBeNull();
  } finally {
    if (previousUrl === undefined) delete process.env.OCD_WEB_CLI_PANEL_URL;
    else process.env.OCD_WEB_CLI_PANEL_URL = previousUrl;
    server.stop(true);
  }
}, 20_000);
