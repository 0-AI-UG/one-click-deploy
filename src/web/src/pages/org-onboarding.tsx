import { useState, useEffect } from "react";
import { put, post } from "../api/client.ts";
import { useAuth, orgPath } from "../stores/auth.ts";
import { showToast, Spinner, Card } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Server, ArrowRight, Key } from "lucide-react";
import { errMsg } from "../lib/errors.ts";

type ServerTypeInfo = { name: string; description: string; cores: number; memory: number; disk: number; locations: string[] };

export function OrgOnboardingPage() {
  const { currentOrgId } = useAuth();
  const [providerToken, setProviderToken] = useState("");
  const [dnsZoneId, setDnsZoneId] = useState("");
  const [serverType, setServerType] = useState("");
  const [location, setLocation] = useState("");
  const [serverTypes, setServerTypes] = useState<ServerTypeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingTypes, setFetchingTypes] = useState(false);

  // Fetch server types when provider token changes
  useEffect(() => {
    if (providerToken.length < 10 || !currentOrgId) return;
    const timer = setTimeout(async () => {
      setFetchingTypes(true);
      try {
        const res = await post(`/api/orgs/${currentOrgId}/server-types`, { provider_token: providerToken });
        if (res.server_types?.length) {
          setServerTypes(res.server_types);
          if (!serverType) setServerType(res.server_types[0].name);
        }
      } catch {} finally { setFetchingTypes(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [providerToken]);

  // Reset location when server type changes and current location is invalid
  const selectedType = serverTypes.find((t) => t.name === serverType);
  const validLocations = selectedType?.locations || [];
  useEffect(() => {
    if (validLocations.length > 0 && !validLocations.includes(location)) {
      setLocation(validLocations[0]);
    }
  }, [serverType, validLocations.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerToken) { showToast("Provider token is required", "error"); return; }
    setLoading(true);
    try {
      await put(`/api/orgs/${currentOrgId}/settings`, {
        provider_token: providerToken,
        dns_zone_id: dnsZoneId,
        default_server_type: serverType,
        default_location: location,
      });
      showToast("Organization configured successfully!");
      window.location.hash = orgPath("/");
    } catch (err) {
      showToast(errMsg(err) || "Failed to save settings", "error");
    } finally { setLoading(false); }
  };

  const typeOptions = serverTypes.map((t) => ({
    value: t.name,
    label: `${t.name} — ${t.cores} vCPU, ${t.memory}GB RAM, ${t.disk}GB`,
  }));
  const locationOptions = validLocations.map((l) => ({ value: l, label: l }));

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg animate-slide-up">
        <div className="text-center mb-6">
          <Server size={32} className="text-fg mx-auto mb-3" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">Configure Infrastructure</h1>
          <p className="text-[10px] text-muted font-mono mt-1 uppercase tracking-wider">Add your cloud provider credentials to start deploying</p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <Key size={16} className="text-fg" />
              <h3 className="font-mono font-bold text-sm text-fg uppercase">Provider Credentials</h3>
            </div>

            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner API Token</label>
              <input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder="Your Hetzner Cloud API token" required />
              {fetchingTypes && <div className="flex items-center gap-2 mt-1.5 font-mono text-[9px] text-fg/60"><Spinner /> Verifying token...</div>}
            </div>
            <div>
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID <span className="text-fg/40">(optional)</span></label>
              <input type="text" value={dnsZoneId} onChange={(e) => setDnsZoneId(e.target.value)} placeholder="Hetzner DNS zone ID" />
            </div>
            {typeOptions.length > 0 && (
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
                <NeoSelect value={serverType} options={typeOptions} onChange={setServerType} />
              </div>
            )}
            {locationOptions.length > 0 && (
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Location</label>
                <NeoSelect value={location} options={locationOptions} onChange={setLocation} />
              </div>
            )}

            <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35">
              {loading ? <Spinner /> : <><span>Save & Continue</span><ArrowRight size={14} /></>}
            </button>
            <button type="button" onClick={() => { window.location.hash = orgPath("/"); }} className="w-full font-mono text-[9px] text-fg/40 hover:text-fg transition-all py-1 uppercase tracking-wider">
              Skip for now
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
