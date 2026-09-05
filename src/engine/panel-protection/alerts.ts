import db, { getSettings, getPanel, saveSetting } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";

export type Condition = { key: string; title: string; path: string; grace?: number; hold?: boolean };
type Incident = { key: string; incident_id: string; title: string; path: string; first_seen: number; opened_at: number | null; resolved_at: number | null };
type EmailPayload = { from: string; to: string[]; subject: string; text: string };
export function enqueueEmail(id: string, subject: string, text: string, now = Date.now()): void {
  const settings = getSettings();
  if (!settings.panel_alert_recipient) return;
  const payload: EmailPayload = { from: settings.panel_alert_sender || "OCD <onboarding@resend.dev>", to: [settings.panel_alert_recipient], subject, text };
  db.query("INSERT OR IGNORE INTO panel_email_outbox (id, payload, created_at, next_attempt) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(payload), now, now);
}
function notify(incident: Incident, recovered: boolean, now: number) {
  const domain = getPanel()?.domain;
  const link = domain ? `https://${domain}/#${incident.path}` : `Open OCD: ${incident.path}`;
  enqueueEmail(`${incident.incident_id}:${recovered ? "recovery" : "open"}`, `[OCD] ${recovered ? "Recovered: " : ""}${incident.title}`, `${incident.title}\n\n${recovered ? "This condition has cleared." : "This condition needs attention."}\nFirst observed: ${new Date(incident.first_seen).toISOString()}\n${link}\n\nOpen the panel to inspect details.`, now);
}
export function reconcileIncidents(conditions: Condition[], now = Date.now()): void {
  db.transaction(() => {
    const active = new Set(conditions.map(c => c.key));
    for (const condition of conditions) {
      if (condition.hold) continue;
      let row = db.query("SELECT * FROM panel_alerts WHERE key=?").get(condition.key) as Incident | null;
      if (!row || row.resolved_at !== null) {
        db.query("INSERT OR REPLACE INTO panel_alerts (key, incident_id, title, path, first_seen) VALUES (?, ?, ?, ?, ?)").run(condition.key, crypto.randomUUID(), condition.title, condition.path, now);
        row = db.query("SELECT * FROM panel_alerts WHERE key=?").get(condition.key) as Incident;
      }
      if (row.opened_at === null && now - row.first_seen >= (condition.grace ?? 0)) {
        notify(row, false, now);
        db.query("UPDATE panel_alerts SET opened_at=? WHERE key=?").run(now, row.key);
      }
    }
    for (const row of db.query("SELECT * FROM panel_alerts WHERE resolved_at IS NULL").all() as Incident[]) {
      if (active.has(row.key)) continue;
      if (row.opened_at !== null) notify(row, true, now);
      db.query("UPDATE panel_alerts SET resolved_at=? WHERE key=?").run(now, row.key);
    }
  })();
}

export function collectConditions(now = Date.now()): Condition[] {
  const result: Condition[] = [];
  for (const app of db.query(`SELECT id, name FROM apps WHERE status='unhealthy'`).all() as { id: number; name: string }[]) {
    result.push({ key: `app:${app.id}`, title: `${app.name} is unhealthy`, path: `/apps/${app.id}`, grace: 120_000 });
  }
  for (const metric of db.query(`SELECT s.id, s.name, m.disk_used_gb, m.disk_total_gb FROM servers s JOIN server_metrics_samples m ON m.id=(SELECT id FROM server_metrics_samples WHERE server_id=s.id ORDER BY sampled_at DESC, id DESC LIMIT 1) WHERE m.sampled_at > datetime('now','-5 minutes') AND m.disk_total_gb > 0 AND m.disk_used_gb/m.disk_total_gb >= 0.9`).all() as { id: number; name: string }[]) {
    result.push({ key: `disk:${metric.id}`, title: `${metric.name} disk usage exceeds 90%`, path: `/resources/servers/${metric.id}`, grace: 120_000 });
  }
  // A missing/stale scrape is not evidence that disk pressure recovered.
  for (const old of db.query(`SELECT a.key, a.title, a.path FROM panel_alerts a
      JOIN servers s ON a.key='disk:' || s.id
      WHERE a.resolved_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM server_metrics_samples m WHERE m.server_id=s.id
        AND m.sampled_at > datetime('now','-5 minutes') AND m.disk_total_gb > 0
      )`).all() as Condition[]) result.push({ ...old, hold: true });
  const settings = getSettings();
  {
    const latest = db.query("SELECT status FROM panel_backups WHERE status IN ('complete','failed') ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { status: string } | null;
    if (latest?.status === "failed") result.push({ key: "backup:failed", title: "Panel backup failed", path: "/admin" });
    const last = Number(settings.panel_backup_last_success || settings.panel_backup_enabled_at || now);
    if (settings.panel_backup_enabled === "1" && now - last > 26 * 3600_000) result.push({ key: "backup:overdue", title: "Panel backup is overdue", path: "/admin" });
  }
  // One incident per deployment target, resolved by a later successful delivery.
  const since = settings.panel_alert_enabled_at || String(now);
  const operations = db.query(`SELECT id, kind, status, resource_keys FROM operations WHERE parent_id IS NULL AND kind IN ('deploy','deploy_stack','redeploy','build_app_delivery','build_stack_delivery','webhook_build_source','apply_manifest','promote','promote_stack','rollback') AND finished_at IS NOT NULL AND julianday(finished_at) >= julianday(?, 'unixepoch') ORDER BY id`).all(Number(since) / 1000) as { id: number; kind: string; status: string; resource_keys: string }[];
  const latest = new Map<string, typeof operations[number]>();
  for (const op of operations) if (op.status !== "cancelled") latest.set(op.resource_keys, op);
  for (const [target, op] of latest) {
    if (["failed", "compensated", "compensation_failed"].includes(op.status)) result.push({ key: `delivery:${target}`, title: `Deployment operation #${op.id} failed`, path: `/engine/op/${op.id}` });
  }
  return result;
}

export async function deliverEmails(fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const key = await secretStore.get("panel_alert_resend_key");
  if (!key || getSettings().panel_alert_enabled !== "1") return;
  const pending = db.query("SELECT * FROM panel_email_outbox WHERE sent_at IS NULL AND attempts < 12 AND next_attempt <= ? ORDER BY created_at LIMIT 10").all(now) as { id: string; payload: string; attempts: number; created_at: number }[];
  for (const email of pending) {
    try {
      const response = await fetcher("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": email.id }, body: email.payload, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Resend HTTP ${response.status}; check API key, sender domain, and recipient`);
      db.query("UPDATE panel_email_outbox SET sent_at=?, error='' WHERE id=?").run(now, email.id);
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("Resend HTTP") ? error.message : "Email delivery failed; check connectivity to Resend";
      db.query("UPDATE panel_email_outbox SET attempts=attempts+1, next_attempt=?, error=? WHERE id=?").run(now + Math.min(3600_000, 30_000 * 2 ** email.attempts), message, email.id);
    }
  }
  db.query("DELETE FROM panel_email_outbox WHERE sent_at IS NOT NULL AND created_at < ?").run(now - 30 * 86400_000);
}
export async function alertTick(): Promise<void> {
  const s = getSettings();
  if (s.panel_alert_enabled !== "1") return;
  if (!s.panel_alert_enabled_at) saveSetting("panel_alert_enabled_at", String(Date.now()));
  reconcileIncidents(collectConditions());
  await deliverEmails();
}
