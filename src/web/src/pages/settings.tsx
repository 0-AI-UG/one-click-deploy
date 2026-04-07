import { useState, useEffect, useRef } from "react";
import { get, post, put } from "../api/client.ts";
import { Card, Btn, Spinner, showToast, confirm } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Settings as SettingsIcon, Save, Download, Upload, Key } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";

export function SettingsPage() {
  const [form, setForm] = useState({
    hetzner_api_token: "", github_pat: "",
    dns_zone_id: "", default_server_type: "", default_location: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { serverTypes } = useServerTypes();

  useEffect(() => {
    get("/api/settings").then((data) => {
      setForm(data);
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
  }, []);

  // Auto-select first available type/location if none saved
  useEffect(() => {
    if (serverTypes.length > 0 && !form.default_server_type) {
      const first = serverTypes[0];
      setForm((f) => ({ ...f, default_server_type: first.name, default_location: first.locations[0] ?? "" }));
    }
  }, [serverTypes, form.default_server_type]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportSshKey = async () => {
    try {
      const data = await get("/api/settings/ssh-key/export");
      const bundle = JSON.stringify(data, null, 2);
      const blob = new Blob([bundle], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ocd-ssh-key-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("SSH key exported — keep this file safe", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const importSshKey = async (file: File) => {
    if (!await confirm("Import SSH Key", "This overwrites the current SSH key. Servers provisioned with the old key will be unreachable without a backup.", true)) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await post("/api/settings/ssh-key/import", parsed);
      showToast("SSH key imported — you can now operate servers from the source instance", "success");
    } catch (err: any) {
      showToast(err.message || "Invalid key file", "error");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await put("/api/settings", form);
      showToast("Settings saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-2 mb-6">
        <SettingsIcon size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Settings</h1>
      </div>

      <Card className="p-5 space-y-4">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">API Tokens</h3>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner API Token</label>
          <input type="password" value={form.hetzner_api_token} onChange={set("hetzner_api_token")} placeholder="Enter token" />
        </div>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">GitHub Personal Access Token</label>
          <input type="password" value={form.github_pat} onChange={set("github_pat")} placeholder="Optional" />
        </div>

        <div className="border-t-2 border-fg pt-4">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Defaults</h3>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID</label>
            <input type="text" value={form.dns_zone_id} onChange={set("dns_zone_id")} placeholder="Hetzner DNS Zone ID" />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
              <NeoSelect
                value={form.default_server_type}
                onChange={(v) => {
                  setForm((f) => {
                    const locs = locationOptions(serverTypes, v);
                    const locValid = locs.some((l) => l.value === f.default_location);
                    return { ...f, default_server_type: v, ...(!locValid && locs.length ? { default_location: locs[0].value } : {}) };
                  });
                }}
                options={typeOptions(serverTypes)}
              />
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Location</label>
              <NeoSelect
                value={form.default_location}
                onChange={(v) => setForm((f) => ({ ...f, default_location: v }))}
                options={locationOptions(serverTypes, form.default_server_type)}
              />
            </div>
          </div>
        </div>

        <div className="pt-2">
          <Btn variant="primary" loading={saving} onClick={save}><Save size={13} /> Save Settings</Btn>
        </div>
      </Card>

      <Card className="p-5 space-y-4 mt-4">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">SSH Key</h3>
        </div>
        <p className="font-mono text-[9px] text-fg/70 leading-snug">
          Share this instance's SSH key with another OCD instance to manage the same fleet.
        </p>
        <div className="flex gap-2">
          <Btn onClick={exportSshKey}><Download size={13} /> Export SSH Key</Btn>
          <Btn onClick={() => fileInputRef.current?.click()}><Upload size={13} /> Import SSH Key</Btn>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importSshKey(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="font-mono text-[9px] text-red-600 leading-snug">
          The export contains a private key that can root every provisioned server. Handle like a password.
        </p>
      </Card>
    </div>
  );
}
