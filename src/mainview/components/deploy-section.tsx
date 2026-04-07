import { useState, useEffect, useRef } from "react";
import { request, onDeployProgress, connectDeployStream } from "../rpc.ts";
import type { ServerWithApps } from "../../shared/rpc.ts";
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

export function DeploySection({
  servers,
  onDeployed,
}: {
  servers: ServerWithApps[];
  onDeployed: () => void;
}) {
  const [gitRepo, setGitRepo] = useState("");
  const [appNameOverride, setAppNameOverride] = useState("");
  const [domain, setDomain] = useState("");
  const [showOpts, setShowOpts] = useState(false);
  const [port, setPort] = useState("3000");
  const [envVars, setEnvVars] = useState("");
  const [serverId, setServerId] = useState("new");
  const [multiContainer, setMultiContainer] = useState(false);
  const [dockerfilePath, setDockerfilePath] = useState("");
  const [volumeSize, setVolumeSize] = useState("");
  const [volumePath, setVolumePath] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookBranch, setWebhookBranch] = useState("main");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [composeWebService, setComposeWebService] = useState("");
  const [replicas, setReplicas] = useState("1");
  const [deploying, setDeploying] = useState(false);
  const [stepStatuses, setStepStatuses] = useState<Record<string, StepStatus>>({});
  const [stepDetails, setStepDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!deploying) return undefined;
    const closeStream = connectDeployStream(appName);
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

  const derivedName = gitRepo
    .replace(/\.git$/, "")
    .split("/")
    .pop()
    ?.replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase() || "";
  const appName = appNameOverride || derivedName;

  const presetWebPanel = () => {
    const jwt = crypto.randomUUID() + crypto.randomUUID();
    setGitRepo("https://github.com/0-AI-UG/one-click-deploy.git");
    setAppNameOverride("ocd-panel");
    setPort("3001");
    setEnvVars(
      `OCD_MODE=server\nNODE_ENV=production\nOCD_DATA_DIR=/app/data\nPORT=3001\nJWT_SECRET=${jwt}`,
    );
    setVolumeSize("10");
    setVolumePath("/app/data");
    setShowOpts(true);
  };

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
        dockerfile_path: dockerfilePath || undefined,
        volume_size: volumeSize ? parseInt(volumeSize, 10) : undefined,
        volume_path: volumePath || undefined,
        webhook_enabled: webhookEnabled || undefined,
        webhook_branch: webhookEnabled ? webhookBranch : undefined,
        auth_password: authEnabled && authPassword ? authPassword : undefined,
        compose_web_service: composeWebService || undefined,
        replicas: parseInt(replicas, 10) > 1 ? parseInt(replicas, 10) : undefined,
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
    setAppNameOverride("");
    setDomain("");
    setEnvVars("");
    setVolumeSize("");
    setVolumePath("");
    setWebhookEnabled(false);
    setWebhookBranch("main");
    setMultiContainer(false);
    setAuthEnabled(false);
    setAuthPassword("");
    setComposeWebService("");
    setReplicas("1");
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
          <input value={gitRepo} onChange={e => { setGitRepo(e.target.value); setAppNameOverride(""); }} placeholder="github.com/user/repo.git" className="inp" />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={presetWebPanel} className="act" title="Prefill config to deploy this tool as a web panel">
              ⚡ web panel preset
            </button>
          </div>
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
              {/* Single / Multi container toggle */}
              <div style={{ display: 'flex', gap: 0, border: 'var(--b)', overflow: 'hidden' }}>
                <button
                  type="button"
                  className="mono"
                  onClick={() => { setMultiContainer(false); setComposeWebService(""); }}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700,
                    letterSpacing: '.04em', cursor: 'pointer', border: 'none',
                    background: !multiContainer ? 'var(--fg)' : 'var(--bg-raised)',
                    color: !multiContainer ? 'var(--bg)' : 'var(--fg-dim)',
                    borderRight: '1.5px solid var(--fg)',
                  }}
                >
                  SINGLE CONTAINER
                </button>
                <button
                  type="button"
                  className="mono"
                  onClick={() => { setMultiContainer(true); }}
                  style={{
                    flex: 1, padding: '5px 0', fontSize: 9, fontWeight: 700,
                    letterSpacing: '.04em', cursor: 'pointer', border: 'none',
                    background: multiContainer ? 'var(--fg)' : 'var(--bg-raised)',
                    color: multiContainer ? 'var(--bg)' : 'var(--fg-dim)',
                  }}
                >
                  MULTI CONTAINER
                </button>
              </div>
              {!multiContainer ? (
                <input value={dockerfilePath} onChange={e => setDockerfilePath(e.target.value)} placeholder="Dockerfile path (auto-detect)" className="inp" style={{ width: '100%' }} />
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={dockerfilePath} onChange={e => setDockerfilePath(e.target.value)} placeholder="Compose file (auto)" className="inp" style={{ flex: 1 }} />
                  <input value={composeWebService} onChange={e => setComposeWebService(e.target.value)} placeholder="Web service (auto)" className="inp" style={{ flex: 1 }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" value={volumeSize} onChange={e => setVolumeSize(e.target.value)} placeholder="Vol GB" className="inp" style={{ width: 70, flex: 'none' }} min={10} max={10240} />
                <input value={volumePath} onChange={e => setVolumePath(e.target.value)} placeholder="/data" className="inp" style={{ flex: 1, opacity: volumeSize ? 1 : 0.35 }} disabled={!volumeSize} />
              </div>
              {volumeSize && (
                <div className="mono" style={{ fontSize: 8, color: 'var(--fg-dim)', lineHeight: 1.4 }}>
                  ⚠ Mount path must match where your app stores data inside the container (e.g. /app/data), not just /data. Check your Dockerfile's WORKDIR.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 1 }}>
                  <input type="checkbox" checked={webhookEnabled} onChange={e => setWebhookEnabled(e.target.checked)} />
                  <span className="mono" style={{ fontSize: 9, fontWeight: 600 }}>Auto-redeploy on push</span>
                </label>
                {webhookEnabled && (
                  <input value={webhookBranch} onChange={e => setWebhookBranch(e.target.value)} placeholder="main" className="inp" style={{ width: 80, flex: 'none', fontSize: 9 }} />
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 1 }}>
                  <input type="checkbox" checked={authEnabled} onChange={e => setAuthEnabled(e.target.checked)} />
                  <span className="mono" style={{ fontSize: 9, fontWeight: 600 }}>Password protect</span>
                </label>
                {authEnabled && (
                  <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="Password" className="inp" style={{ width: 120, flex: 'none', fontSize: 9 }} />
                )}
              </div>
              {/* Replicas */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono" style={{ fontSize: 9, fontWeight: 600, flex: 'none' }}>Replicas</span>
                <input
                  type="number"
                  value={replicas}
                  onChange={e => setReplicas(e.target.value)}
                  min={1}
                  max={10}
                  className="inp"
                  style={{ width: 50, flex: 'none', fontSize: 9, textAlign: 'center' }}
                />
                {parseInt(replicas, 10) > 1 && (
                  <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)' }}>
                    ~{replicas} servers + LB (~€6/mo)
                  </span>
                )}
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
