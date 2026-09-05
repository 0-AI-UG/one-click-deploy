import { useEffect, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { Card, Btn, Field, showToast } from "../../components/ui.tsx";

type Form = { backup_connection: string; backup_enabled: boolean; backup_bucket: string; backup_prefix: string; backup_retention: number; alert_enabled: boolean; alert_recipient: string; alert_sender: string };
type State = Form & {
  storage_connections: Array<{ id: string; name: string; region: string }>;
  resend_configured: boolean; recovery_key_configured: boolean; storage_configured: boolean; recovery_pending: boolean; pending_operations: number;
  backups: { id: string; created_at: number; status: string; bucket: string; object_key: string; error: string }[];
  alerts: { key: string; title: string; resolved_at: number | null }[];
  deliveries: { id: string; sent_at: number | null; attempts: number; error: string }[];
};
export function PanelProtection() {
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [resumeOps, setResumeOps] = useState(false);
  const load = async (reset = false) => {
    const s = await get("/api/admin/protection");
    setState(s);
    setForm(f => !f || reset ? { backup_connection: s.backup_connection, backup_enabled: s.backup_enabled, backup_bucket: s.backup_bucket, backup_prefix: s.backup_prefix, backup_retention: s.backup_retention, alert_enabled: s.alert_enabled, alert_recipient: s.alert_recipient, alert_sender: s.alert_sender } : f);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => void load().catch(() => {}), 10000); return () => clearInterval(timer); }, []);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); } finally { setBusy(false); } };
  if (!form || !state) return <Card className="p-5">{error || "Loading panel protection…"}</Card>;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const save = async () => {
    await put("/api/admin/protection", { ...form, ...(apiKey ? { resend_key: apiKey } : {}) });
    setApiKey(""); await load(true); showToast("Panel protection saved", "success");
  };
  const downloadKey = () => {
    const url = URL.createObjectURL(new Blob([recoveryKey + "\n"], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "ocd-panel-recovery-key.txt"; a.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-4">
    {error && <div role="alert" className="border-2 border-fg p-3 text-sm">{error}</div>}
    {state.recovery_pending && <Card className="p-5 space-y-3">
      <h3 className="font-bold">Panel recovery is paused</h3>
      <p>Verify access to existing servers before automation resumes. {state.pending_operations} saved operations may continue. Keep the original panel stopped.</p>
      <label className="block"><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} /> The original panel is stopped</label>
      <label className="block"><input type="checkbox" checked={resumeOps} onChange={e => setResumeOps(e.target.checked)} /> Resume saved operations and reconciliation</label>
      <Btn disabled={busy || !stopped || !resumeOps} onClick={() => action(async () => { await post("/api/admin/protection/resume", { original_panel_stopped: stopped, resume_saved_operations: resumeOps }); await load(true); showToast("Server access verified; automation resumed", "success"); })}>Verify servers and resume</Btn>
      <p className="text-sm">Backups stay disabled after restore until you enable them again.</p>
    </Card>}
    <Card className="p-5 space-y-3">
      <h3 className="font-bold">Panel backups</h3>
      <p className="text-sm">Encrypted daily backups of panel state, credentials, and SSH keys. Application databases and volumes are excluded.</p>
      {!state.storage_configured && <p>Connect and assign object storage in Admin → Providers first.</p>}
      <Field label="Storage connection"><select value={form.backup_connection} onChange={e => set("backup_connection", e.target.value)}><option value="">Select a connection</option>{state.storage_connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.region}</option>)}</select></Field>
      <Field label="Bucket"><input value={form.backup_bucket} onChange={e => set("backup_bucket", e.target.value)} placeholder="my-backups" /></Field>
      <details><summary>Backup options</summary>
        <Field label="Path prefix"><input value={form.backup_prefix} onChange={e => set("backup_prefix", e.target.value)} /></Field>
        <Field label="Backups to retain"><input type="number" min={1} max={90} value={form.backup_retention} onChange={e => set("backup_retention", Number(e.target.value))} /></Field>
      </details>
      <Btn disabled={busy} onClick={() => action(async () => { const r = await post("/api/admin/protection/recovery-key", {}); setRecoveryKey(r.recovery_key); })}>{state.recovery_key_configured ? "Show recovery key" : "Create recovery key"}</Btn>
      {recoveryKey && <div className="space-y-2"><p>Save this key outside the panel. You need it to restore a backup.</p><code className="block break-all select-all">{recoveryKey}</code><Btn onClick={downloadKey}>Download recovery key</Btn><Btn onClick={() => setRecoveryKey("")}>Hide</Btn></div>}
      <label className="block"><input type="checkbox" checked={form.backup_enabled} disabled={!state.storage_configured || !state.recovery_key_configured} onChange={e => set("backup_enabled", e.target.checked)} /> Enable daily backups</label>
      <div className="flex gap-2"><Btn disabled={busy} onClick={() => action(save)}>Save settings</Btn><Btn disabled={busy || state.recovery_pending || !state.recovery_key_configured || !state.storage_configured} onClick={() => action(async () => { await save(); await post("/api/admin/protection/backup", {}); showToast("Backup queued", "success"); })}>Back up now</Btn></div>
      <div className="space-y-2">{state.backups.map(b => <div key={b.id} className="border-t pt-2 text-sm"><strong>{b.status}</strong> · {new Date(b.created_at).toLocaleString()}<code className="block break-all select-all">s3://{b.bucket}/{b.object_key}</code>{b.error && <p>{b.error}</p>}</div>)}</div>
      <details><summary>Restore on a fresh installation</summary><p>Stop the original panel. Supply your saved recovery key and S3 credentials through environment variables, then run:</p><code className="block break-all select-all">bun run scripts/restore-panel.ts --from s3://bucket/path.ocdb --data-dir /new/panel-data</code><p>Mount the restored directory as the panel data directory. Start the matching OCD release and return here to verify servers and resume. See docs/panel-protection.md for the complete procedure.</p></details>
    </Card>
    <Card className="p-5 space-y-3">
      <h3 className="font-bold">Email alerts</h3>
      <p className="text-sm">Deployment failures, unhealthy apps, failed or overdue panel backups, and low disk space. One opening email and one recovery email per incident.</p>
      <Field label="Resend API key"><input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={state.resend_configured ? "Configured — leave blank to keep" : "re_…"} /></Field>
      <Field label="Recipient email"><input type="email" value={form.alert_recipient} onChange={e => set("alert_recipient", e.target.value)} /></Field>
      <details><summary>Custom sender (optional)</summary><Field label="Sender email"><input type="email" value={form.alert_sender} onChange={e => set("alert_sender", e.target.value)} placeholder="alerts@your-domain.com" /></Field></details>
      <p className="text-sm">The default Resend test sender sends to your Resend account email. For other recipients, use a sender on your verified domain.</p>
      <label className="block"><input type="checkbox" checked={form.alert_enabled} onChange={e => set("alert_enabled", e.target.checked)} /> Enable email alerts</label>
      <div className="flex gap-2"><Btn disabled={busy} onClick={() => action(save)}>Save settings</Btn><Btn disabled={busy || !form.alert_enabled} onClick={() => action(async () => { await save(); const r = await post("/api/admin/protection/test-email", {}); if (!r.ok) throw new Error(r.error || "Test email is queued"); showToast("Test email sent", "success"); })}>Send test email</Btn></div>
      {state.alerts.map(a => <p key={a.key} className="text-sm">{a.resolved_at ? "Resolved" : "Active"}: {a.title}</p>)}
      {state.deliveries.length > 0 && <details><summary>Email delivery status</summary>{state.deliveries.map(d => <p key={d.id} className="text-sm">{d.sent_at ? "Sent" : d.attempts >= 12 ? "Failed" : "Pending"}{d.error ? ` — ${d.error}` : ""}</p>)}</details>}
    </Card>
  </div>;
}
