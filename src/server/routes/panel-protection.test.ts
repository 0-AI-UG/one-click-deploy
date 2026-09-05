import { test, expect, mock, beforeEach } from "bun:test";
import db, { saveSetting } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
const realPermissions = await import("../lib/permissions.ts");
let allowed = true;
mock.module("../lib/permissions.ts", () => ({ ...realPermissions, requireAdmin: async () => { if (!allowed) { const e = new Error("Admin required"); Object.defineProperty(e, "constructor", { value: { name: "ForbiddenError" } }); throw e; } return { userId: "admin" }; } }));
const { handleSaveProtection, handleGetProtection, handleRecoveryKey } = await import("./panel-protection.ts");
const request = (body?: unknown) => new Request("https://panel.example/api/admin/protection", { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const config = { backup_connection: "", backup_enabled: false, backup_bucket: "", backup_prefix: "ocd-panel", backup_retention: 7, alert_enabled: true, alert_recipient: "me@example.com", alert_sender: "", resend_key: "re_test-secret" };
beforeEach(() => { allowed = true; });
test("minimal email setup encrypts the key and does not return it", async () => {
  expect((await handleSaveProtection(request(config))).status).toBe(200);
  expect(await secretStore.get("panel_alert_resend_key")).toBe(config.resend_key);
  const response = await handleGetProtection(request()); const body = await response.text();
  expect(body).not.toContain(config.resend_key); expect(JSON.parse(body).resend_configured).toBe(true);
  expect(db.query("SELECT value FROM settings WHERE key='panel_alert_resend_key'").get()).toBeNull();
});
test("validation is atomic and requires prerequisites", async () => {
  expect((await handleSaveProtection(request({ ...config, backup_retention: 0 }))).status).toBe(400);
  expect(await secretStore.get("panel_alert_resend_key")).toBeNull();
  expect((await handleSaveProtection(request({ ...config, backup_enabled: true }))).status).toBe(400);
  expect((await handleSaveProtection(request({ ...config, unexpected: "x" }))).status).toBe(400);
});
test("key retrieval is admin only and stable", async () => {
  allowed = false;
  expect((await handleGetProtection(request())).status).toBe(403);
  expect((await handleRecoveryKey(request())).status).toBe(403);
  allowed = true;
  const first = await (await handleRecoveryKey(request())).json();
  const again = await (await handleRecoveryKey(request())).json();
  expect(first.recovery_key).toMatch(/^[a-f0-9]{64}$/);
  expect(again).toEqual(first);
});

test("simultaneous recovery-key requests return the same persisted key", async () => {
  const responses = await Promise.all([handleRecoveryKey(request()), handleRecoveryKey(request())]);
  const [a,b] = await Promise.all(responses.map(r => r.json()));
  expect(a).toEqual(b);
  expect(await secretStore.get("panel_backup_recovery_key")).toBe(a.recovery_key);
});
test("changing recipient discards pending mail to the previous destination", async () => {
  await handleSaveProtection(request(config));
  db.query("INSERT INTO panel_email_outbox (id,payload,created_at,next_attempt) VALUES ('old','{}',1,1)").run();
  await handleSaveProtection(request({ ...config, alert_recipient: "new@example.com" }));
  expect(db.query("SELECT id FROM panel_email_outbox WHERE id='old'").get()).toBeNull();
});
