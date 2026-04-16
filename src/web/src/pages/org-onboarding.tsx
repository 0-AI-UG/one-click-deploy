import { useState, useEffect } from "react";
import { get, put } from "../api/client.ts";
import { useAuth } from "../stores/auth.ts";
import { showToast, Spinner } from "../components/ui.tsx";

export function OrgOnboardingPage() {
  const { currentOrgId } = useAuth();
  const [providerToken, setProviderToken] = useState("");
  const [dnsZoneId, setDnsZoneId] = useState("");
  const [serverType, setServerType] = useState("");
  const [location, setLocation] = useState("");
  const [serverTypes, setServerTypes] = useState<Array<{ name: string; description: string; cores: number; memory: number; disk: number }>>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingTypes, setFetchingTypes] = useState(false);

  // Fetch server types when provider token changes
  useEffect(() => {
    if (providerToken.length < 10) return;
    const timer = setTimeout(async () => {
      setFetchingTypes(true);
      try {
        const res = await get(`/api/setup/server-types?token=${encodeURIComponent(providerToken)}`);
        if (res.serverTypes) {
          setServerTypes(res.serverTypes);
          if (res.serverTypes.length > 0 && !serverType) setServerType(res.serverTypes[0].name);
        }
        if (res.locations) {
          setLocations(res.locations);
          if (res.locations.length > 0 && !location) setLocation(res.locations[0]);
        }
      } catch {} finally { setFetchingTypes(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [providerToken]);

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
      window.location.hash = "#/";
    } catch (err: any) {
      showToast(err.message || "Failed to save settings", "error");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-lg bg-white border-2 border-fg shadow-neo p-8">
        <h1 className="font-mono font-bold text-xl mb-2 text-fg">Configure Your Infrastructure</h1>
        <p className="font-mono text-xs text-fg/60 mb-6">Add your cloud provider credentials to start deploying.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Hetzner API Token</label>
            <input type="password" value={providerToken} onChange={(e) => setProviderToken(e.target.value)} placeholder="Your Hetzner Cloud API token" required />
          </div>
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">DNS Zone ID <span className="text-fg/40">(optional)</span></label>
            <input type="text" value={dnsZoneId} onChange={(e) => setDnsZoneId(e.target.value)} placeholder="Hetzner DNS zone ID" />
          </div>
          {serverTypes.length > 0 && (
            <div>
              <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Default Server Type</label>
              <select value={serverType} onChange={(e) => setServerType(e.target.value)}>
                {serverTypes.map((t) => (
                  <option key={t.name} value={t.name}>{t.name} — {t.cores} vCPU, {t.memory}GB RAM, {t.disk}GB</option>
                ))}
              </select>
            </div>
          )}
          {locations.length > 0 && (
            <div>
              <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Default Location</label>
              <select value={location} onChange={(e) => setLocation(e.target.value)}>
                {locations.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          )}
          {fetchingTypes && <div className="flex items-center gap-2 font-mono text-xs text-fg/60"><Spinner /> Loading server types...</div>}
          <button type="submit" disabled={loading} className="w-full bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo hover:-translate-y-0.5 hover:shadow-neo-lg transition-all disabled:opacity-50">
            {loading ? <Spinner /> : "Save & Continue"}
          </button>
          <button type="button" onClick={() => { window.location.hash = "#/"; }} className="w-full font-mono text-xs text-fg/60 hover:text-fg transition-all py-1">
            Skip for now
          </button>
        </form>
      </div>
    </div>
  );
}
