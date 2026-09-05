import { test, expect } from "bun:test";
import db, { saveSetting } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { reconcileIncidents, deliverEmails, collectConditions } from "./alerts.ts";

function enable() { saveSetting("panel_alert_enabled", "1"); saveSetting("panel_alert_recipient", "owner@example.com"); }
const count = () => (db.query("SELECT count(*) AS n FROM panel_email_outbox").get() as { n: number }).n;
test("grace period, deduplication and recovery survive repeated evaluations", () => {
  enable();
  const condition = [{ key: "app:1", title: "App unhealthy", path: "/apps/1", grace: 120000 }];
  reconcileIncidents(condition, 1000); reconcileIncidents(condition, 120000);
  expect(count()).toBe(0);
  reconcileIncidents(condition, 121000); reconcileIncidents(condition, 200000);
  expect(count()).toBe(1);
  reconcileIncidents([], 220000); reconcileIncidents([], 240000);
  expect(count()).toBe(2);
  reconcileIncidents(condition, 300000); reconcileIncidents(condition, 420000);
  expect(count()).toBe(3);
});
test("transient conditions do not send recovery mail", () => {
  enable(); reconcileIncidents([{ key: "app:1", title: "Unhealthy", path: "/apps/1", grace: 120000 }], 1000);
  reconcileIncidents([], 3000); expect(count()).toBe(0);
});
test("delivery retries use the same payload and idempotency key without exposing provider errors", async () => {
  enable(); await secretStore.set("panel_alert_resend_key", "test-key");
  reconcileIncidents([{ key: "backup", title: "Backup failed", path: "/admin" }], 1000);
  const calls: RequestInit[] = [];
  const fail = (async (_url: unknown, init: RequestInit) => { calls.push(init); return new Response("secret diagnostic", { status: 503 }); }) as typeof fetch;
  await deliverEmails(fail, 1000);
  expect((db.query("SELECT error FROM panel_email_outbox").get() as { error: string }).error).not.toContain("secret diagnostic");
  await deliverEmails(fail, 2000); expect(calls.length).toBe(1);
  const ok = (async (_url: unknown, init: RequestInit) => { calls.push(init); return Response.json({ id: "sent" }); }) as typeof fetch;
  await deliverEmails(ok, 32000);
  expect(calls[0].body).toBe(calls[1].body);
  expect((calls[0].headers as Record<string, string>)["idempotency-key"]).toBe((calls[1].headers as Record<string, string>)["idempotency-key"]);
  await deliverEmails(ok, 90000); expect(calls.length).toBe(2);
});
test("overdue panel backups use last successful backup or initial enable time", () => {
  saveSetting("panel_backup_enabled", "1"); saveSetting("panel_backup_enabled_at", "1000");
  expect(collectConditions(1000 + 27 * 3600000).some(c => c.key === "backup:overdue")).toBe(true);
  saveSetting("panel_backup_last_success", String(1000 + 26 * 3600000));
  expect(collectConditions(1000 + 27 * 3600000).some(c => c.key === "backup:overdue")).toBe(false);
});
test("retrying a failed backup does not send recovery until a verified backup succeeds", () => {
  db.query("INSERT INTO panel_backups (id,created_at,status,bucket,object_key,endpoint,connection_id,region) VALUES ('failed',1,'failed','b','k','e','test','test'), ('retry',2,'running','b','k2','e','test','test')").run();
  expect(collectConditions().some(c => c.key === "backup:failed")).toBe(true);
  db.query("UPDATE panel_backups SET status='complete' WHERE id='retry'").run();
  expect(collectConditions().some(c => c.key === "backup:failed")).toBe(false);
});
test("unknown observations retain incidents without falsely resolving them", () => {
  enable();
  reconcileIncidents([{ key: "disk:1", title: "Disk full", path: "/resources/servers/1" }], 1000);
  reconcileIncidents([{ key: "disk:1", title: "Disk full", path: "/resources/servers/1", hold: true }], 2000);
  expect(count()).toBe(1);
});
