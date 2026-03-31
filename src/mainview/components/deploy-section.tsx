import { useState, useEffect, useRef } from "react";
import { request, onDeployProgress } from "../rpc.ts";
import type { ServerWithApps } from "../../shared/rpc.ts";

type SelectOption = { value: string; label: string };

function NeoSelect({ value, options, onChange }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mono"
        style={{
          width: '100%', textAlign: 'left',
          background: 'var(--bg-raised)', border: 'var(--b)',
          padding: '7px 10px', fontSize: 10, color: 'var(--fg)',
          cursor: 'pointer', display: 'flex', alignItems: 'center',
          transition: 'box-shadow .1s, transform .1s',
          boxShadow: open ? 'var(--shadow-sm)' : 'none',
          transform: open ? 'translate(-1px,-1px)' : 'none',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label || value}
        </span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, marginLeft: 6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--bg-raised)', border: 'var(--b)', borderTop: 'none',
          boxShadow: 'var(--shadow)',
          maxHeight: 160, overflow: 'auto',
        }}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="mono"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              style={{
                width: '100%', textAlign: 'left', display: 'block',
                padding: '6px 10px', fontSize: 10,
                background: opt.value === value ? 'var(--accent)' : 'transparent',
                color: 'var(--fg)', border: 'none', borderBottom: '1px solid var(--fg)',
                cursor: 'pointer', fontWeight: opt.value === value ? 700 : 400,
              }}
              onMouseEnter={e => { if (opt.value !== value) (e.target as HTMLElement).style.background = 'var(--bg-alt)'; }}
              onMouseLeave={e => { if (opt.value !== value) (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

export function DeploySection({
  servers,
  onDeployed,
}: {
  servers: ServerWithApps[];
  onDeployed: () => void;
}) {
  const [gitRepo, setGitRepo] = useState("");
  const [domain, setDomain] = useState("");
  const [showOpts, setShowOpts] = useState(false);
  const [port, setPort] = useState("3000");
  const [envVars, setEnvVars] = useState("");
  const [serverId, setServerId] = useState("new");
  const [volumeSize, setVolumeSize] = useState("");
  const [volumePath, setVolumePath] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [stepDetails, setStepDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!deploying) return undefined;
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
    return () => { unsub(); };
  }, [deploying]);

  const appName = gitRepo
    .replace(/\.git$/, "")
    .split("/")
    .pop()
    ?.replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase() || "";

  const handleDeploy = async () => {
    setError("");
    setStepStatuses({});
    setStepDetails({});
    setDeploying(true);

    const env: Record<string, string> = {};
    for (const line of envVars.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
    }

    try {
      const result = await request.deploy({
        app_name: appName,
        domain,
        git_repo: gitRepo,
        container_port: parseInt(port, 10),
        env_vars: env,
        server_id: serverId !== "new" ? parseInt(serverId, 10) : undefined,
        volume_size: volumeSize ? parseInt(volumeSize, 10) : undefined,
        volume_path: volumePath || undefined,
      });
      if (!result.ok) setError(result.error || "Deploy failed");
      else onDeployed();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setDeploying(false);
  };

  const allDone = STEPS.every((s) => stepStatuses[s.key] === "done");
  const canDeploy = gitRepo && !deploying;

  const reset = () => {
    setDeploying(false);
    setStepStatuses({});
    setStepDetails({});
    setError("");
    setGitRepo("");
    setDomain("");
    setEnvVars("");
    setVolumeSize("");
    setVolumePath("");
    onDeployed();
  };

  // --- Progress view ---
  if (deploying || Object.keys(stepStatuses).length > 0) {
    const activeStep = STEPS.find(s => stepStatuses[s.key] === "active");
    const activeDetail = activeStep ? stepDetails[activeStep.key] : null;

    return (
      <div>
        <div className="stamp" style={{ marginBottom: 8 }}>Deploying</div>
        <div className="card" style={{ padding: 10 }}>
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

          {(allDone || error) && (
            <button onClick={reset} className="btn btn-ghost" style={{ width: '100%', fontSize: 9 }}>
              {allDone ? 'Deploy Another' : 'Try Again'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- Deploy form ---
  return (
    <div>
      <div className="stamp" style={{ marginBottom: 8 }}>Deploy</div>
      <div className="card" style={{ padding: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={gitRepo} onChange={e => setGitRepo(e.target.value)} placeholder="github.com/user/repo.git" className="inp" />
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="Domain (optional)" className="inp" />

          {/* App name + options row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {appName && <span className="tag" style={{ background: 'var(--accent)' }}>{appName}</span>}
            <div style={{ flex: 1 }} />
            <button className="act" onClick={() => setShowOpts(!showOpts)}>
              {showOpts ? '− opts' : '+ opts'}
            </button>
          </div>

          {showOpts && (
            <>
              <NeoSelect
                value={serverId}
                onChange={setServerId}
                options={[
                  { value: "new", label: "New server" },
                  ...servers.map(s => ({ value: String(s.id), label: `${s.name} (${s.ipv4})` })),
                ]}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className="inp" style={{ width: 70, flex: 'none' }} />
                <input value={envVars} onChange={e => setEnvVars(e.target.value)} placeholder="KEY=val KEY=val" className="inp" style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" value={volumeSize} onChange={e => setVolumeSize(e.target.value)} placeholder="Vol GB" className="inp" style={{ width: 70, flex: 'none' }} />
                <input value={volumePath} onChange={e => setVolumePath(e.target.value)} placeholder="/data" className="inp" style={{ flex: 1, opacity: volumeSize ? 1 : 0.35 }} disabled={!volumeSize} />
              </div>
            </>
          )}

          <button onClick={handleDeploy} disabled={!canDeploy} className="btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            </svg>
            Deploy
          </button>
        </div>
      </div>
    </div>
  );
}
