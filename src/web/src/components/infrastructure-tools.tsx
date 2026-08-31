import { useEffect, useMemo, useState } from "react";
import { Hammer, KeyRound, Link2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { get } from "../api/client.ts";
import { runCliAction } from "../api/cli-actions.ts";
import { Btn, Card, CopyButton, Field, Table, confirm, showToast } from "./ui.tsx";
import { NeoSelect } from "./neo-select.tsx";
import { PermissionGate } from "./permission-gate.tsx";

type Server = { id: number; name: string; ipv4: string; status: string; pool?: string; apps?: Array<{ id: number }> };
type Worker = { id: number; name: string; status: string; worker_version: string; architecture: string; last_error: string; disk_free_bytes?: number; server: Server | null };
type Source = { id: number; repository: string; branch: string; webhook_secret_configured: boolean; last_status: string; last_error: string };
type GcRow = { server: { id: number; name: string }; images: unknown[]; reclaimable_ocd_image_bytes: number; reclaimable_foreign_image_bytes: number };

const stripAnsi = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
const bytes = (value: number) => value > 0 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : "0 MiB";

export function InfrastructureTools() {
  const [servers, setServers] = useState<Server[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [worker, setWorker] = useState({ server: "", name: "", removalToken: "" });
  const [workerBusy, setWorkerBusy] = useState(false);
  const [webhook, setWebhook] = useState<{ url: string; secret: string } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [enrollmentKey, setEnrollmentKey] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [connect, setConnect] = useState({ name: "", address: "", privateAddress: "", hostKey: "", sshUser: "root", sshPort: "22", pool: "general" });
  const [gcServer, setGcServer] = useState("");
  const [gcRows, setGcRows] = useState<GcRow[] | null>(null);
  const [gcBusy, setGcBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const load = async () => {
    const [serverRows, workerRows, sourceRows] = await Promise.all([get("/api/servers"), get("/api/runners"), get("/api/build-sources")]);
    setServers(serverRows || []); setWorkers(workerRows || []); setSources(sourceRows || []);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const eligible = useMemo(() => servers.filter((server) =>
    server.status === "ready" && !server.apps?.length && !workers.some((item) => item.server?.id === server.id)
  ), [servers, workers]);

  const installWorker = async () => {
    if (!worker.server) return;
    setWorkerBusy(true);
    try {
      await runCliAction("runners.install", { server: worker.server, name: worker.name || undefined, removalToken: worker.removalToken || undefined });
      setWorker({ server: "", name: "", removalToken: "" }); showToast("Build worker installed", "success"); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "Install failed", "error"); }
    finally { setWorkerBusy(false); }
  };

  const removeWorker = async (item: Worker) => {
    if (!await confirm("Remove Build Worker", `Remove ${item.name} and return ${item.server?.name || "its server"} to its previous pool?`, true)) return;
    setWorkerBusy(true);
    try { await runCliAction("runners.remove", { runner: String(item.id) }, { confirmed: true }); showToast("Build worker removed", "success"); await load(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Removal failed", "error"); }
    finally { setWorkerBusy(false); }
  };

  const rotateWebhook = async (source: Source) => {
    if (!await confirm("Rotate Webhook Secret", `Rotate the secret for ${source.repository}#${source.branch}? The previous secret stops working immediately.`, true)) return;
    try {
      const result = await runCliAction("runners.webhook-secret", { source: String(source.id) }, { confirmed: true });
      const output = stripAnsi(result.stdout);
      const url = output.match(/^Payload URL:\s*(.+)$/m)?.[1]?.trim();
      const secret = output.match(/^Secret \(shown once\):\s*(.+)$/m)?.[1]?.trim();
      if (!url || !secret) throw new Error("CLI did not return a webhook secret");
      setWebhook({ url, secret }); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "Rotation failed", "error"); }
  };

  const openConnect = async () => {
    setConnectOpen((value) => !value);
    if (enrollmentKey) return;
    try { setEnrollmentKey(stripAnsi((await runCliAction("servers.enrollment-key")).stdout).trim()); }
    catch (error) { showToast(error instanceof Error ? error.message : "Could not load enrollment key", "error"); }
  };
  const connectServer = async () => {
    setConnectBusy(true);
    try {
      await runCliAction("servers.connect", connect); showToast("External server connected", "success"); setConnectOpen(false);
      setConnect({ name: "", address: "", privateAddress: "", hostKey: "", sshUser: "root", sshPort: "22", pool: "general" }); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "Connection failed", "error"); }
    finally { setConnectBusy(false); }
  };

  const previewGc = async () => {
    setGcBusy(true);
    try { const rows = await get(`/api/gc${gcServer ? `?server=${encodeURIComponent(gcServer)}` : ""}`); setGcRows(rows); setPreviewKey(gcServer || "all"); }
    catch (error) { showToast(error instanceof Error ? error.message : "GC preview failed", "error"); }
    finally { setGcBusy(false); }
  };
  const executeGc = async () => {
    if (previewKey !== (gcServer || "all")) return showToast("Run a fresh preview first", "error");
    const total = (gcRows || []).reduce((sum, row) => sum + row.reclaimable_ocd_image_bytes + row.reclaimable_foreign_image_bytes, 0);
    if (!await confirm("Execute Disk Cleanup", `Reclaim the previewed safe assets (${bytes(total)})?`, true)) return;
    setGcBusy(true);
    try { await runCliAction("gc.execute", { server: gcServer || undefined }, { confirmed: true }); showToast("Disk cleanup complete", "success"); setPreviewKey(null); await previewGc(); }
    catch (error) { showToast(error instanceof Error ? error.message : "GC failed", "error"); }
    finally { setGcBusy(false); }
  };

  return <div className="space-y-6">
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-2"><Hammer size={13} /> Build workers</h2><p className="mt-1 font-mono text-[9px] text-muted">Dedicated BuildKit capacity and GitHub push sources.</p></div><Btn size="xs" onClick={load}><RefreshCw size={11} /> Refresh</Btn></div>
      {workers.length > 0 && <Table headers={["Worker", "Server", "Status", "Version", "Disk", ""]}>{workers.map((item) => <tr key={item.id}>
        <td className="px-3 py-2 font-mono text-[10px] font-bold">{item.name}</td><td className="px-3 py-2 font-mono text-[10px]">{item.server?.name || "Missing"}</td><td className="px-3 py-2 font-mono text-[10px]">{item.status}{item.last_error && <div className="text-accent-red">{item.last_error}</div>}</td><td className="px-3 py-2 font-mono text-[10px]">{item.worker_version || "—"}<div className="text-muted">{item.architecture || "—"}</div></td><td className="px-3 py-2 font-mono text-[10px]">{item.disk_free_bytes ? `${(item.disk_free_bytes / 1024 ** 3).toFixed(1)} GB` : "—"}</td><td className="px-3 py-2"><PermissionGate permission="servers.manage"><Btn size="xs" variant="danger" disabled={workerBusy} onClick={() => removeWorker(item)}><Trash2 size={11} /></Btn></PermissionGate></td>
      </tr>)}</Table>}
      <PermissionGate permission="servers.manage"><div className="grid gap-3 md:grid-cols-3"><Field label="Dedicated server"><NeoSelect value={worker.server} onChange={(server) => setWorker((form) => ({ ...form, server }))} options={eligible.map((item) => ({ value: String(item.id), label: item.name }))} placeholder="Select empty server" /></Field><Field label="Worker name"><input value={worker.name} onChange={(e) => setWorker((form) => ({ ...form, name: e.target.value }))} placeholder="ocd-build-1" /></Field><Field label="Legacy removal token"><input type="password" value={worker.removalToken} onChange={(e) => setWorker((form) => ({ ...form, removalToken: e.target.value }))} placeholder="Only for conversion" /></Field></div><Btn size="sm" variant="primary" loading={workerBusy} disabled={!worker.server} onClick={installWorker}><Hammer size={12} /> Install worker</Btn></PermissionGate>
      {sources.length > 0 && <><div className="border-t-2 border-fg/20 pt-4 font-mono text-[9px] font-bold uppercase">Repository webhooks</div><Table headers={["Repository", "Branch", "Status", "Webhook", ""]}>{sources.map((source) => <tr key={source.id}><td className="px-3 py-2 font-mono text-[10px] break-all">{source.repository}</td><td className="px-3 py-2 font-mono text-[10px]">{source.branch}</td><td className="px-3 py-2 font-mono text-[10px]">{source.last_status || "idle"}{source.last_error && <div className="text-accent-red">{source.last_error}</div>}</td><td className="px-3 py-2 font-mono text-[10px]">{source.webhook_secret_configured ? "ready" : "missing"}</td><td className="px-3 py-2"><PermissionGate permission="servers.manage"><Btn size="xs" onClick={() => rotateWebhook(source)}><KeyRound size={11} /> Rotate</Btn></PermissionGate></td></tr>)}</Table></>}
      {webhook && <div className="border-2 border-fg bg-alt p-3 space-y-2"><div className="font-mono text-[9px] font-bold uppercase">Webhook secret — shown once</div><div className="flex items-center gap-1 font-mono text-[10px] break-all"><strong>URL:</strong> {webhook.url}<CopyButton text={webhook.url} /></div><div className="flex items-center gap-1 font-mono text-[10px] break-all"><strong>Secret:</strong> {webhook.secret}<CopyButton text={webhook.secret} /></div></div>}
    </Card>

    <Card className="p-5 space-y-4"><div className="flex items-center justify-between"><div><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider flex items-center gap-2"><Link2 size={13} /> Connect external server</h2><p className="mt-1 font-mono text-[9px] text-muted">Enroll an externally owned stateless host.</p></div><PermissionGate permission="servers.manage"><Btn size="xs" onClick={openConnect}>{connectOpen ? "Close" : "Connect"}</Btn></PermissionGate></div>
      {connectOpen && <div className="space-y-3 border-t-2 border-fg/20 pt-4"><div className="border-2 border-fg bg-alt p-3"><div className="font-mono text-[9px] font-bold uppercase">1. Install this public key for the SSH user</div><div className="mt-2 flex items-start gap-1 font-mono text-[10px] break-all">{enrollmentKey || "Loading…"}{enrollmentKey && <CopyButton text={enrollmentKey} />}</div></div><div className="grid gap-3 md:grid-cols-2"><Field label="Name"><input value={connect.name} onChange={(e) => setConnect((form) => ({ ...form, name: e.target.value }))} /></Field><Field label="Management address"><input value={connect.address} onChange={(e) => setConnect((form) => ({ ...form, address: e.target.value }))} placeholder="203.0.113.10" /></Field><Field label="Private address"><input value={connect.privateAddress} onChange={(e) => setConnect((form) => ({ ...form, privateAddress: e.target.value }))} placeholder="10.0.0.10" /></Field><Field label="SSH host key"><input value={connect.hostKey} onChange={(e) => setConnect((form) => ({ ...form, hostKey: e.target.value }))} placeholder="host ssh-ed25519 AAAA…" /></Field><Field label="SSH user / port"><div className="flex gap-2"><input value={connect.sshUser} onChange={(e) => setConnect((form) => ({ ...form, sshUser: e.target.value }))} /><input className="!w-24" value={connect.sshPort} onChange={(e) => setConnect((form) => ({ ...form, sshPort: e.target.value }))} /></div></Field><Field label="Pool"><input value={connect.pool} onChange={(e) => setConnect((form) => ({ ...form, pool: e.target.value }))} /></Field></div><Btn size="sm" variant="primary" loading={connectBusy} disabled={!connect.name || !connect.address || !connect.privateAddress || !connect.hostKey} onClick={connectServer}><ShieldCheck size={12} /> Verify and connect</Btn></div>}
    </Card>

    <Card className="p-5 space-y-4"><div><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider">Disk cleanup</h2><p className="mt-1 font-mono text-[9px] text-muted">Preview is mandatory; runtime and rollback images remain protected.</p></div><div className="flex items-end gap-2"><div className="min-w-56"><Field label="Server"><NeoSelect value={gcServer} onChange={(value) => { setGcServer(value); setPreviewKey(null); }} options={servers.map((item) => ({ value: String(item.id), label: item.name }))} placeholder="All servers" /></Field></div><Btn size="sm" loading={gcBusy} onClick={previewGc}>Preview</Btn><PermissionGate permission="servers.manage"><Btn size="sm" variant="danger" loading={gcBusy} disabled={!gcRows || previewKey !== (gcServer || "all")} onClick={executeGc}>Execute preview</Btn></PermissionGate></div>{gcRows && <Table headers={["Server", "Images", "OCD reclaimable", "Foreign reclaimable"]}>{gcRows.map((row) => <tr key={row.server.id}><td className="px-3 py-2 font-mono text-[10px] font-bold">{row.server.name}</td><td className="px-3 py-2 font-mono text-[10px]">{row.images.length}</td><td className="px-3 py-2 font-mono text-[10px]">{bytes(row.reclaimable_ocd_image_bytes)}</td><td className="px-3 py-2 font-mono text-[10px]">{bytes(row.reclaimable_foreign_image_bytes)}</td></tr>)}</Table>}
    </Card>
  </div>;
}
