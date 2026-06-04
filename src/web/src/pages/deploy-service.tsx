import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { Card, Btn, showToast, Spinner, CopyButton } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { InfoTip } from "./app-detail/shared.tsx";
import { Database, Loader2, Eye, EyeOff, ArrowLeft, RefreshCw } from "lucide-react";

type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: Array<{ key: string; label: string; generate?: string; default?: string }>;
  editableSecrets?: Array<{ key: string; label: string; generate?: string }>;
  defaultVolumeSize: number;
  icon?: string;
  color?: string;
  http?: boolean;
  stateless?: boolean;
  description?: string;
  category?: string;
  recommendedMemoryMb?: number;
};

type Environment = {
  id: number;
  name: string;
};

function randomPassword(len = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function isPasswordKey(key: string): boolean {
  return /password/i.test(key);
}

export function DeployServicePage({ preselectedType }: { preselectedType?: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [volumeSize, setVolumeSize] = useState(10);
  const [generatedEnv, setGeneratedEnv] = useState<Record<string, string>>({});
  const [credentialFields, setCredentialFields] = useState<Array<{ key: string; label: string; isPassword: boolean }>>([]);
  const [deploying, setDeploying] = useState(false);
  const [environmentId, setEnvironmentId] = useState<number | null>(null);
  const [envPrefix, setEnvPrefix] = useState("DATABASE");
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [customDomain, setCustomDomain] = useState("");

  useEffect(() => {
    Promise.all([
      get("/api/services/catalog"),
      get("/api/environments"),
    ])
      .then(([catalogData, envData]: [CatalogEntry[], Environment[]]) => {
        setCatalog(catalogData);
        setEnvironments(envData);
        if (preselectedType) {
          const entry = catalogData.find((e: CatalogEntry) => e.type === preselectedType);
          if (entry) selectService(entry);
        }
        setLoading(false);
      })
      .catch((err: any) => {
        showToast(err.message, "error");
        setLoading(false);
      });
  }, []);

  const selectService = (entry: CatalogEntry) => {
    setSelected(entry);
    setName(`my-${entry.type}`);
    setVersion(entry.versions[0]);
    setVolumeSize(entry.defaultVolumeSize);
    setRevealedKeys(new Set());
    // Seed editable credential fields with sensible defaults; the user can
    // change any of them before deploying (blank = auto-generated server-side).
    const env: Record<string, string> = {};
    const fields: Array<{ key: string; label: string; isPassword: boolean }> = [];
    for (const v of entry.requiredEnvVars) {
      if (v.generate === "password") env[v.key] = randomPassword();
      else if (v.generate === "username") env[v.key] = "ocd_user";
      else if (v.default) env[v.key] = v.default;
      else env[v.key] = "";
      fields.push({ key: v.key, label: v.label, isPassword: isPasswordKey(v.key) });
    }
    for (const s of entry.editableSecrets || []) {
      env[s.key] = s.generate === "password" ? randomPassword() : "";
      fields.push({ key: s.key, label: s.label, isPassword: isPasswordKey(s.key) || s.generate === "password" });
    }
    setGeneratedEnv(env);
    setCredentialFields(fields);
  };

  const regenerate = (key: string) => {
    setGeneratedEnv((prev) => ({ ...prev, [key]: randomPassword() }));
  };

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDeploy = async () => {
    if (!selected || !name) return;
    setDeploying(true);
    try {
      const res = await post("/api/services/deploy", {
        name,
        service_type: selected.type,
        version,
        volume_size: selected.stateless ? undefined : volumeSize,
        // Drop blanks so cleared fields fall back to server-side generation.
        env_overrides: Object.fromEntries(Object.entries(generatedEnv).filter(([, v]) => v !== "")),
        environment_id: environmentId || undefined,
        env_prefix: environmentId ? envPrefix : undefined,
        domain: selected.http && customDomain ? customDomain.trim() : undefined,
      });
      window.location.hash = `#/deploy/service-progress/${res.op_id}`;
    } catch (err: any) {
      showToast(err.message, "error");
      setDeploying(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy Service</h1>
        <p className="text-[10px] text-muted font-mono mt-0.5">Deploy a managed database or cache</p>
      </div>

      {selected && (
        <div className="space-y-4">
          <Btn variant="ghost" onClick={() => { window.location.hash = "#/deploy"; }}><ArrowLeft size={14} /></Btn>

          <Card>
            <div className="px-4 py-3 border-b-2 border-fg bg-alt flex items-center gap-3">
              <div className={`w-8 h-8 ${selected.color || "bg-gray-500"} flex items-center justify-center text-white font-mono text-[10px] font-bold`}>
                {selected.icon || selected.label.slice(0, 2)}
              </div>
              <div>
                <span className="font-mono text-[11px] font-bold text-fg uppercase">{selected.label}</span>
                <span className="font-mono text-[9px] text-muted ml-2">Port {selected.defaultPort}</span>
              </div>
            </div>
            <div className="p-4 space-y-4">
              {selected.recommendedMemoryMb ? (
                <div className="bg-alt border-2 border-fg/30 px-3 py-2">
                  <p className="font-mono text-[9px] text-muted">
                    Needs ~{(selected.recommendedMemoryMb / 1024).toFixed(0)}GB RAM — a larger server is provisioned automatically. <InfoTip text="Reusing a small existing server may be tight on memory." />
                  </p>
                </div>
              ) : null}
              {/* Name */}
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Service Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className="w-full bg-bg border-2 border-fg px-3 py-2 font-mono text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent-blue"
                />
              </div>

              {/* Version */}
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Version</label>
                <NeoSelect
                  value={version}
                  onChange={setVersion}
                  options={selected.versions.map((v) => ({ value: v, label: `${selected.label} ${v}` }))}
                />
              </div>

              {/* Volume */}
              {!selected.stateless && (
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Volume Size (GB)</label>
                  <input
                    type="number"
                    value={volumeSize}
                    onChange={(e) => setVolumeSize(parseInt(e.target.value, 10) || 10)}
                    min={10}
                    className="w-full bg-bg border-2 border-fg px-3 py-2 font-mono text-xs text-fg focus:outline-none"
                  />
                </div>
              )}

              {/* Custom domain (HTTP services only) */}
              {selected.http && (
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">
                    Custom Domain <span className="font-normal text-muted ml-1">(optional)</span> <InfoTip text="Point the domain's A record at the server first." />
                  </label>
                  <input
                    type="text"
                    value={customDomain}
                    placeholder={`${name || "service"}.<server-ip>.nip.io (auto-generated if left blank)`}
                    onChange={(e) => setCustomDomain(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ""))}
                    className="w-full bg-bg border-2 border-fg px-3 py-2 font-mono text-xs text-fg focus:outline-none"
                  />
                </div>
              )}

              {/* Credentials (editable) */}
              {credentialFields.length > 0 && (
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Credentials</label>
                <div className="bg-alt border-2 border-fg/30 divide-y divide-fg/10">
                  {credentialFields.map((f) => {
                    const revealed = revealedKeys.has(f.key);
                    const value = generatedEnv[f.key] ?? "";
                    return (
                      <div key={f.key} className="px-3 py-2 flex items-center gap-2">
                        <label className="font-mono text-[9px] text-muted uppercase shrink-0 w-28 truncate" title={f.label}>{f.label}</label>
                        <input
                          type={f.isPassword && !revealed ? "password" : "text"}
                          value={value}
                          onChange={(e) => setGeneratedEnv((prev) => ({ ...prev, [f.key]: e.target.value }))}
                          className="flex-1 min-w-0 bg-bg border border-fg/30 px-2 py-1 font-mono text-[10px] text-fg focus:outline-none focus:ring-1 focus:ring-accent-blue"
                        />
                        {f.isPassword && (
                          <>
                            <button
                              onClick={() => toggleReveal(f.key)}
                              className="p-0.5 text-muted hover:text-fg transition-colors shrink-0"
                              title={revealed ? "Hide" : "Reveal"}
                            >
                              {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                            <button
                              onClick={() => regenerate(f.key)}
                              className="p-0.5 text-muted hover:text-fg transition-colors shrink-0"
                              title="Regenerate"
                            >
                              <RefreshCw size={12} />
                            </button>
                          </>
                        )}
                        <CopyButton text={value} />
                      </div>
                    );
                  })}
                </div>
                <p className="font-mono text-[9px] text-muted mt-1">
                  Edit any field before deploying. Cleared fields are auto-generated.
                </p>
              </div>
              )}

              {/* Environment */}
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">
                  Add to Environment
                  <span className="font-normal text-muted ml-1">(optional)</span> <InfoTip text="Inject connection credentials into this environment on deploy" />
                </label>
                <NeoSelect
                  value={environmentId ? String(environmentId) : ""}
                  onChange={(v) => setEnvironmentId(v ? Number(v) : null)}
                  options={[
                    { value: "", label: "None — add manually later" },
                    ...environments.map((e) => ({ value: String(e.id), label: e.name })),
                  ]}
                />
              </div>

              {/* Env Prefix */}
              {environmentId && (
                <div>
                  <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Env Prefix</label>
                  <input
                    type="text"
                    value={envPrefix}
                    onChange={(e) => setEnvPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                    className="w-full bg-bg border-2 border-fg px-3 py-2 font-mono text-xs text-fg focus:outline-none"
                  />
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {["URL", "HOST", "PASSWORD"].map((s) => (
                      <span key={s} className="font-mono text-[9px] text-muted border border-fg/40 px-1.5 py-0.5">{(envPrefix || "PREFIX")}_{s}</span>
                    ))}
                  </div>
                </div>
              )}

              <Btn
                onClick={handleDeploy}
                variant="primary"
                loading={deploying}
                className="w-full"
              >
                <Database size={14} /> Deploy {selected.label}
              </Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
