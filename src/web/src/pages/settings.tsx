import { useState, useEffect } from "react";
import { get, put } from "../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Settings as SettingsIcon, Save } from "lucide-react";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";

export function SettingsPage() {
  const [form, setForm] = useState({
    hetzner_api_token: "", hetzner_dns_token: "", github_pat: "",
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
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner DNS Token</label>
          <input type="password" value={form.hetzner_dns_token} onChange={set("hetzner_dns_token")} placeholder="Optional" />
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
    </div>
  );
}
