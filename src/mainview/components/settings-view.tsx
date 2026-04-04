import { useState, useEffect } from "react";
import { request, onDeployProgress, connectDeployStream } from "../rpc.ts";
import type { Settings, ServerWithApps } from "../../shared/rpc.ts";
import { NeoSelect } from "./neo-select.tsx";

const STEPS = [
  { key: "server", label: "SRV" },
  { key: "provision", label: "PRV" },
  { key: "dns", label: "DNS" },
  { key: "build", label: "BLD" },
  { key: "caddy", label: "TLS" },
  { key: "health", label: "CHK" },
  { key: "done", label: "OK" },
];

type StepStatus = "pending" | "active" | "done" | "error";

type HetznerServerType = { name: string; description: string; cores: number; memory: number; disk: number; locations: string[] };

export function SettingsView({ settings, servers, onSaved }: { settings: Settings; servers: ServerWithApps[]; onSaved: () => void }) {
  const [token, setToken] = useState(settings.hetzner_api_token);
  const [dnsToken, setDnsToken] = useState(settings.hetzner_dns_token);
  const [githubPat, setGithubPat] = useState(settings.github_pat);
  const [zoneId, setZoneId] = useState(settings.dns_zone_id);
  const [serverType, setServerType] = useState(settings.default_server_type || "");
  const [location, setLocation] = useState(settings.default_location || "");
  const [saving, setSaving] = useState(false);
  const [serverTypes, setServerTypes] = useState<HetznerServerType[]>([]);

  useEffect(() => {
    request.getServerTypes({}).then((data: any) => {
      const types = data.server_types ?? [];
      setServerTypes(types);
      if (!serverType && types.length > 0) setServerType(types[0].name);
      if (!location && types.length > 0 && types[0].locations.length > 0) setLocation(types[0].locations[0]);
    }).catch(() => {});
  }, []);

  const selectedType = serverTypes.find(t => t.name === serverType);
  const availableLocations = selectedType?.locations ?? [];

  // If current location isn't valid for the selected type, auto-fix
  useEffect(() => {
    if (availableLocations.length > 0 && !availableLocations.includes(location)) {
      setLocation(availableLocations[0]);
    }
  }, [serverType, availableLocations]);

  const save = async () => {
    setSaving(true);
    await request.saveSettings({ ...settings, hetzner_api_token: token, hetzner_dns_token: dnsToken, github_pat: githubPat, dns_zone_id: zoneId, default_server_type: serverType, default_location: location });
    setSaving(false);
    onSaved();
  };

  return (
    <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div className="stamp" style={{ marginBottom: 8 }}>Settings</div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label className="lbl">API Token</label>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Hetzner API token" className="inp" />
            </div>
            <div>
              <label className="lbl">DNS Token</label>
              <input type="password" value={dnsToken} onChange={e => setDnsToken(e.target.value)} placeholder="DNS API token" className="inp" />
            </div>
            <div>
              <label className="lbl">GitHub Token</label>
              <input type="password" value={githubPat} onChange={e => setGithubPat(e.target.value)} placeholder="Optional — for private repos & webhooks" className="inp" />
              <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginTop: 2, display: 'block' }}>
                Scopes: repo + admin:repo_hook
              </span>
            </div>
            <div>
              <label className="lbl">Zone ID</label>
              <input value={zoneId} onChange={e => setZoneId(e.target.value)} placeholder="Optional" className="inp" />
            </div>
            {serverTypes.length > 0 && (
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <label className="lbl">Server Type</label>
                  <NeoSelect
                    value={serverType}
                    onChange={setServerType}
                    options={serverTypes.map(t => ({ value: t.name, label: `${t.name} (${t.cores}c/${t.memory}GB)` }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="lbl">Location</label>
                  <NeoSelect
                    value={location}
                    onChange={setLocation}
                    options={availableLocations.map(l => ({ value: l, label: l }))}
                  />
                </div>
              </div>
            )}
            <button onClick={save} disabled={saving || !token} className="btn" style={{ width: '100%' }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      <DeployWebPanel servers={servers} />
    </div>
  );
}

function DeployWebPanel({ servers }: { servers: ServerWithApps[] }) {
  const [domain, setDomain] = useState("");
  const [serverId, setServerId] = useState("new");
  const [deploying, setDeploying] = useState(false);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [stepDetails, setStepDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [deployedUrl, setDeployedUrl] = useState("");

  useEffect(() => {
    if (!deploying) return undefined;
    const closeStream = connectDeployStream("ocd-panel");
    const unsub = onDeployProgress(({ step, detail }) => {
      if (step === "error") {
        setError(detail);
        setStepStatuses((prev) => {
          const next = { ...prev };
          for (const k of Object.keys(next)) {
            if (next[k] === "active") next[k] = "error";
          }
          return next;
        });
        return;
      }
      setStepStatuses((prev) => {
        const next = { ...prev };
        const stepIdx = STEPS.findIndex((s) => s.key === step);
        for (let i = 0; i < STEPS.length; i++) {
          const k = STEPS[i].key;
          if (i < stepIdx) next[k] = "done";
          else if (i === stepIdx) next[k] = step === "done" ? "done" : "active";
        }
        return next;
      });
      setStepDetails((prev) => ({ ...prev, [step]: detail }));
    });
    return () => { unsub(); closeStream(); };
  }, [deploying]);

  const handleDeploy = async () => {
    setError("");
    setStepStatuses({});
    setStepDetails({});
    setDeployedUrl("");
    setDeploying(true);

    try {
      const result = await request.selfDeploy({
        domain,
        server_id: serverId !== "new" ? parseInt(serverId, 10) : undefined,
      });
      if (!result.ok) {
        setError(result.error || "Deploy failed");
      } else if (result.url) {
        setDeployedUrl(result.url);
      }
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setDeploying(false);
  };

  const allDone = STEPS.every((s) => stepStatuses[s.key] === "done");
  const activeStep = STEPS.find(s => stepStatuses[s.key] === "active");
  const activeDetail = activeStep ? stepDetails[activeStep.key] : null;
  const hasProgress = deploying || Object.keys(stepStatuses).length > 0;

  const reset = () => {
    setDeploying(false);
    setStepStatuses({});
    setStepDetails({});
    setError("");
    setDeployedUrl("");
    setDomain("");
    setServerId("new");
  };

  return (
    <div>
      <div className="stamp" style={{ marginBottom: 8 }}>Deploy Web Panel</div>
      <div className="card" style={{ padding: 12 }}>
        {hasProgress ? (
          <div>
            {/* Step chips */}
            <div style={{ display: 'flex', gap: 3, marginBottom: 8 }}>
              {STEPS.map((step) => {
                const status = stepStatuses[step.key] || "pending";
                const bg =
                  status === "done" ? 'var(--accent)' :
                  status === "active" ? 'var(--amber)' :
                  status === "error" ? 'var(--red)' : 'var(--bg-alt)';
                const fg = status === "error" ? '#fff' : status === "pending" ? 'var(--fg-faint)' : 'var(--fg)';
                return (
                  <div
                    key={step.key}
                    className={`mono ${status === "active" ? "pulse" : ""}`}
                    style={{
                      flex: 1, textAlign: 'center', fontSize: 8, fontWeight: 700,
                      padding: '4px 0', background: bg, color: fg,
                      border: '1.5px solid var(--fg)',
                      textDecoration: status === "done" ? 'line-through' : 'none',
                      letterSpacing: '.04em',
                    }}
                  >
                    {step.label}
                  </div>
                );
              })}
            </div>

            {activeDetail && !error && !allDone && (
              <div className="mono" style={{ fontSize: 9, color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 6 }}>
                {activeDetail}
              </div>
            )}

            {error && (
              <div className="mono" style={{ fontSize: 9, fontWeight: 700, color: 'var(--red)', padding: '5px 8px', background: 'var(--red-dim)', border: '1.5px solid var(--red)', marginBottom: 6 }}>
                {error}
              </div>
            )}

            {allDone && deployedUrl && (
              <div style={{ marginBottom: 6 }}>
                <div className="mono" style={{ fontSize: 9, color: 'var(--fg-dim)', marginBottom: 4 }}>
                  Web panel deployed! Visit to set up your admin account:
                </div>
                <a
                  href={deployedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono"
                  style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-blue)', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  {deployedUrl}
                </a>
              </div>
            )}

            {(allDone || error) && (
              <button onClick={reset} className="btn btn-ghost" style={{ width: '100%', fontSize: 9 }}>
                {allDone ? 'Done' : 'Try Again'}
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="mono" style={{ fontSize: 8, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
              Deploy One-Click Deploy as a web app with multi-user auth, so your team can deploy from the browser.
            </div>
            <div>
              <label className="lbl">Domain (optional)</label>
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="panel.example.com" className="inp" />
              {!domain && (
                <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', marginTop: 2, display: 'block' }}>
                  Will use {'{ip}'}.nip.io if left empty
                </span>
              )}
            </div>
            <NeoSelect
              value={serverId}
              onChange={setServerId}
              options={[
                { value: "new", label: "New server" },
                ...servers.map(s => ({ value: String(s.id), label: `${s.name} (${s.ipv4})` })),
              ]}
            />
            <button onClick={handleDeploy} disabled={deploying} className="btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
              Deploy Web Panel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
