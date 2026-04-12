import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { Card, Btn, showToast, Spinner, CopyButton } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Database, Loader2 } from "lucide-react";

type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: Array<{ key: string; label: string; generate?: string; default?: string }>;
  defaultVolumeSize: number;
};

const SERVICE_ICONS: Record<string, string> = {
  postgresql: "PG",
  mysql: "My",
  mariadb: "Ma",
  redis: "Re",
  mongodb: "Mo",
};

const SERVICE_COLORS: Record<string, string> = {
  postgresql: "bg-blue-600",
  mysql: "bg-orange-500",
  mariadb: "bg-teal-600",
  redis: "bg-red-500",
  mongodb: "bg-green-600",
};

function randomPassword(len = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function DeployServicePage({ preselectedType }: { preselectedType?: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [volumeSize, setVolumeSize] = useState(10);
  const [generatedEnv, setGeneratedEnv] = useState<Record<string, string>>({});
  const [deploying, setDeploying] = useState(false);

  useEffect(() => {
    get("/api/services/catalog")
      .then((data: CatalogEntry[]) => {
        setCatalog(data);
        if (preselectedType) {
          const entry = data.find((e: CatalogEntry) => e.type === preselectedType);
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
    // Generate credentials
    const env: Record<string, string> = {};
    for (const v of entry.requiredEnvVars) {
      if (v.generate === "password") env[v.key] = randomPassword();
      else if (v.generate === "username") env[v.key] = "ocd_user";
      else if (v.default) env[v.key] = v.default;
    }
    setGeneratedEnv(env);
  };

  const handleDeploy = async () => {
    if (!selected || !name) return;
    setDeploying(true);
    try {
      const res = await post("/api/services/deploy", {
        name,
        service_type: selected.type,
        version,
        volume_size: volumeSize,
        env_overrides: generatedEnv,
      });
      window.location.hash = `#/deploy/service-progress/${res.deployment_id}`;
    } catch (err: any) {
      showToast(err.message, "error");
      setDeploying(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div>
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy Service</h1>
        <p className="text-[10px] text-muted font-mono mt-0.5">Deploy a managed database or cache</p>
      </div>

      {selected && (
        <div className="space-y-4">
          <a
            href="#/deploy"
            className="font-mono text-[10px] text-muted hover:text-fg transition-colors uppercase"
          >
            &larr; Back to deploy
          </a>

          <Card>
            <div className="px-4 py-3 border-b-2 border-fg bg-alt flex items-center gap-3">
              <div className={`w-8 h-8 ${SERVICE_COLORS[selected.type] || "bg-gray-500"} flex items-center justify-center text-white font-mono text-[10px] font-bold`}>
                {SERVICE_ICONS[selected.type] || "??"}
              </div>
              <div>
                <span className="font-mono text-[11px] font-bold text-fg uppercase">{selected.label}</span>
                <span className="font-mono text-[9px] text-muted ml-2">Port {selected.defaultPort}</span>
              </div>
            </div>
            <div className="p-4 space-y-4">
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

              {/* Generated Credentials */}
              <div>
                <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Credentials</label>
                <div className="bg-alt border-2 border-fg/30 divide-y divide-fg/10">
                  {Object.entries(generatedEnv).map(([key, value]) => (
                    <div key={key} className="px-3 py-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-[9px] text-muted uppercase shrink-0">{key}</span>
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="font-mono text-[10px] text-fg truncate">{value}</span>
                        <CopyButton text={value} />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="font-mono text-[8px] text-muted mt-1">These credentials are auto-generated. You can change them before deploying.</p>
              </div>

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
