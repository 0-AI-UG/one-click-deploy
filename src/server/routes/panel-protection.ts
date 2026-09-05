import { storageConnection, getProviderConnections } from "../../shared/provider-connections.ts";
import { z } from "zod";
import { unlinkSync } from "node:fs";
import db, { getSettings, saveSetting, getServers } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { corsHeaders } from "../lib/cors.ts";
import { getS3Credentials, validateBucketName } from "../../engine/object-storage/s3.ts";
import { listBackups, requestBackup } from "../../engine/panel-protection/backups.ts";
import { generateRecoveryKey } from "../../engine/panel-protection/archive.ts";
import { enqueueEmail, deliverEmails } from "../../engine/panel-protection/alerts.ts";
import { recoveryPending, recoveryMarker } from "../../engine/panel-protection/recovery-state.ts";
import { sshExec } from "../../shared/remote/index.ts";

const settingsSchema = z.object({
  backup_enabled: z.boolean(),
  backup_connection: z.string(),
  backup_bucket: z.string().max(63).refine(v => !v || (validateBucketName(v).valid && v === v.trim().toLowerCase()), "Invalid bucket"),
  backup_prefix: z.string().max(200).regex(/^[a-zA-Z0-9_/-]*$/).refine(v => !v.startsWith("/") && !v.endsWith("/") && !v.includes("//"), "Use a relative prefix without trailing slash"),
  backup_retention: z.number().int().min(1).max(90),
  alert_enabled: z.boolean(),
  alert_recipient: z.union([z.literal(""), z.email()]),
  alert_sender: z.union([z.literal(""), z.email()]),
  resend_key: z.string().max(256).regex(/^[\x21-\x7e]*$/).optional(),
}).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });
export async function handleGetProtection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const s = getSettings();
    return json({
      backup_connection: s.panel_backup_connection || "",
      storage_connections: getProviderConnections().filter(p => p.kind === "s3-compatible").map(p => ({ id: p.id, name: p.name, region: p.config.region })),
      backup_enabled: s.panel_backup_enabled === "1", backup_bucket: s.panel_backup_bucket || "", backup_prefix: s.panel_backup_prefix || "ocd-panel", backup_retention: Number(s.panel_backup_retention || 7),
      alert_enabled: s.panel_alert_enabled === "1", alert_recipient: s.panel_alert_recipient || "", alert_sender: s.panel_alert_sender || "",
      resend_configured: !!await secretStore.get("panel_alert_resend_key"), recovery_key_configured: !!await secretStore.get("panel_backup_recovery_key"), storage_configured: !!(s.panel_backup_connection && await getS3Credentials(s.panel_backup_connection)), recovery_pending: recoveryPending(),
      backups: listBackups(), alerts: db.query("SELECT * FROM panel_alerts WHERE opened_at IS NOT NULL ORDER BY first_seen DESC LIMIT 50").all(),
      deliveries: db.query("SELECT id, created_at, attempts, sent_at, error FROM panel_email_outbox ORDER BY created_at DESC LIMIT 20").all(),
      pending_operations: (db.query("SELECT count(*) AS n FROM operations WHERE status IN ('pending','running','compensating')").get() as { n: number }).n,
    });
  } catch (error) { return handleError(error); }
}
export async function handleSaveProtection(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const parsed = settingsSchema.safeParse(await request.json());
    if (!parsed.success) return json({ error: "Invalid protection settings", issues: parsed.error.issues.map(i => ({ field: i.path.join("."), message: i.message })) }, 400);
    const value = parsed.data;
    if (value.backup_enabled && (!value.backup_bucket || !(value.backup_connection && await getS3Credentials(value.backup_connection)) || !await secretStore.get("panel_backup_recovery_key"))) return json({ error: "Connect object storage, choose a bucket, and save your recovery key before enabling backups" }, 400);
    if (value.alert_enabled && (!value.alert_recipient || !(value.resend_key ?? await secretStore.get("panel_alert_resend_key")))) return json({ error: "Enter a Resend API key and recipient email" }, 400);
    if (value.resend_key !== undefined) {
      if (value.resend_key) await secretStore.set("panel_alert_resend_key", value.resend_key);
      else await secretStore.delete("panel_alert_resend_key");
    }
    if (value.backup_connection) {
      const connection = storageConnection(value.backup_connection);
      if (!connection) return json({ error: "Select a storage connection" }, 400);
      value.backup_connection = connection.id;
    }
    const old = getSettings();
    db.transaction(() => {
      for (const [key, val] of Object.entries(value)) {
        if (key === "resend_key") continue;
        saveSetting(`panel_${key}`, typeof val === "boolean" ? (val ? "1" : "0") : String(val));
      }
      if (value.backup_enabled && old.panel_backup_enabled !== "1") saveSetting("panel_backup_enabled_at", String(Date.now()));
      if (value.alert_enabled && (old.panel_alert_enabled !== "1" || old.panel_alert_recipient !== value.alert_recipient || (old.panel_alert_sender || "") !== value.alert_sender)) {
        saveSetting("panel_alert_enabled_at", String(Date.now()));
        // Enabling a new destination starts a fresh notification timeline.
        db.run("DELETE FROM panel_alerts");
        db.run("DELETE FROM panel_email_outbox WHERE sent_at IS NULL");
      }
    })();
    return json({ ok: true });
  } catch (error) { return handleError(error); }
}
let recoveryKeyCreation: Promise<string> | null = null;
async function savedRecoveryKey(): Promise<string> {
  if (!recoveryKeyCreation) recoveryKeyCreation = (async () => {
    const existing = await secretStore.get("panel_backup_recovery_key");
    if (existing) return existing;
    const key = generateRecoveryKey();
    await secretStore.set("panel_backup_recovery_key", key);
    return key;
  })();
  const pending = recoveryKeyCreation;
  try { return await pending; }
  finally { if (recoveryKeyCreation === pending) recoveryKeyCreation = null; }
}
export async function handleRecoveryKey(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    return json({ recovery_key: await savedRecoveryKey() });
  } catch (error) { return handleError(error); }
}
export async function handleBackupNow(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    if (recoveryPending()) return json({ error: "Resume panel recovery before creating a backup" }, 409);
    try { return json({ id: await requestBackup() }, 202); }
    catch { return json({ error: "Configure object storage, backup bucket, and recovery key first" }, 400); }
  } catch (error) { return handleError(error); }
}
export async function handleTestEmail(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const s = getSettings();
    if (s.panel_alert_enabled !== "1" || !s.panel_alert_recipient || !await secretStore.get("panel_alert_resend_key")) return json({ error: "Save and enable email alerts first" }, 400);
    const id = `test:${crypto.randomUUID()}`;
    enqueueEmail(id, "[OCD] Test email", "Email alerts are configured for your OCD panel.");
    await deliverEmails();
    const delivery = db.query("SELECT sent_at, error FROM panel_email_outbox WHERE id=?").get(id) as { sent_at: number | null; error: string };
    return json({ ok: !!delivery.sent_at, error: delivery.error || undefined, queued: !delivery.sent_at });
  } catch (error) { return handleError(error); }
}
export async function handleResumeRecovery(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    if (!recoveryPending()) return json({ ok: true });
    const body = await request.json() as { original_panel_stopped?: boolean; resume_saved_operations?: boolean };
    if (body.original_panel_stopped !== true || body.resume_saved_operations !== true) return json({ error: "Confirm that the original panel is stopped and saved operations may resume" }, 400);
    const failures: string[] = [];
    for (const server of getServers()) {
      if (!server.ssh_host_key) { failures.push(`${server.name}: no pinned SSH host key`); continue; }
      try {
        const result = await sshExec(server.management_address || server.ipv4, "docker ps --format '{{.Names}}' >/dev/null", server.ssh_host_key, { user: server.ssh_user, port: server.ssh_port });
        if (result.exitCode !== 0) failures.push(`${server.name}: Docker access failed`);
      } catch { failures.push(`${server.name}: SSH access failed`); }
    }
    if (failures.length) return json({ error: "Server verification failed; automation remains paused", failures }, 409);
    unlinkSync(recoveryMarker);
    const { startEngineInProcess } = await import("../../engine/entrypoint.ts");
    if (process.env.OCD_ENGINE !== "0") startEngineInProcess();
    return json({ ok: true, backups_enabled: false });
  } catch (error) { return handleError(error); }
}
