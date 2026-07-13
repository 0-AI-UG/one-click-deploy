import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { get, post } from "../../api/client.ts";
import { Btn, showToast, Spinner } from "../../components/ui.tsx";
import {
  Boxes, Box, Database, Globe, Lock, Loader2, CheckCircle2, ArrowRight, AlertTriangle,
  ChevronDown, ChevronRight, Settings2, Plus, X,
} from "lucide-react";
import { DeployModeTabs } from "./mode-tabs.tsx";
import { StackAppOptions } from "./stack-app-options.tsx";
import type { StackIntrospectResult, StackDeployBody, StackAppSpec, StackServiceSpec, StackEnvDef } from "../../types.ts";

// Per-app env values: appKey -> (envKey -> value)
type EnvState = Record<string, Record<string, string>>;

const inputCls =
  "bg-bg border-2 border-fg/40 px-2 py-1 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-fg";

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[9px] uppercase tracking-wider text-muted shrink-0">{label}</span>
      <span className="text-fg truncate text-right">{value}</span>
    </div>
  );
}

// --- Service row with editable version / volume / env overrides -------------
function ServiceRow({ svc, onChange }: { svc: StackServiceSpec; onChange: (patch: Partial<StackServiceSpec>) => void }) {
  const [open, setOpen] = useState(false);
  const overrides = Object.entries(svc.env_overrides ?? {});
  const setOverride = (i: number, k: string, v: string) => {
    const next = overrides.map(([ek, ev], idx) => (idx === i ? [k, v] : [ek, ev])) as Array<[string, string]>;
    onChange({ env_overrides: Object.fromEntries(next.filter(([ek]) => ek)) });
  };
  return (
    <div className="border-2 border-fg/15 p-2.5">
      <div className="flex items-center gap-3 flex-wrap">
        <Database size={12} className="text-muted shrink-0" />
        <span className="font-mono text-[11px] font-bold text-fg uppercase">{svc.key}</span>
        <span className="font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5">{svc.type}</span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[8px] text-muted uppercase">ver</span>
          <input value={svc.version ?? ""} placeholder="default" onChange={(e) => onChange({ version: e.target.value || undefined })} className={`${inputCls} w-24`} />
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[8px] text-muted uppercase">vol GB</span>
          <input type="number" value={svc.volume_size ?? ""} onChange={(e) => onChange({ volume_size: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${inputCls} w-16`} />
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto inline-flex items-center gap-1 font-mono text-[9px] text-fg-dim hover:text-fg">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} env overrides
        </button>
      </div>
      {open && (
        <div className="mt-2 pl-6 space-y-1">
          {overrides.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1">
              <input value={k} onChange={(e) => setOverride(i, e.target.value, v)} placeholder="KEY" className={`${inputCls} w-40`} />
              <span className="text-muted text-[10px]">=</span>
              <input value={v} onChange={(e) => setOverride(i, k, e.target.value)} placeholder="value" className={`${inputCls} w-40`} />
              <button type="button" onClick={() => onChange({ env_overrides: Object.fromEntries(overrides.filter((_, idx) => idx !== i)) })} className="text-muted hover:text-accent-red"><X size={12} /></button>
            </div>
          ))}
          <button type="button" onClick={() => onChange({ env_overrides: { ...(svc.env_overrides ?? {}), "": "" } })} className="inline-flex items-center gap-1 font-mono text-[9px] text-fg-dim hover:text-fg"><Plus size={10} /> add override</button>
        </div>
      )}
    </div>
  );
}

export function StackDeployPage() {
  const [repoUrl, setRepoUrl] = useState("");
  const [stackPath, setStackPath] = useState("ocd-stack.json");
  const [branch, setBranch] = useState<string>("");

  const [introspecting, setIntrospecting] = useState(false);
  const [result, setResult] = useState<StackIntrospectResult | null>(null);
  const [specs, setSpecs] = useState<StackAppSpec[]>([]);
  const [services, setServices] = useState<StackServiceSpec[]>([]);
  const [env, setEnv] = useState<EnvState>({});
  const [openApp, setOpenApp] = useState<Set<string>>(new Set());
  const [deploying, setDeploying] = useState(false);
  const seq = useRef(0);

  const runIntrospect = useCallback(async (url: string, ref: string | undefined, path: string) => {
    if (!/github\.com[/:][^/]+\/[^/]+/.test(url)) {
      setResult(null);
      setIntrospecting(false);
      return;
    }
    const mySeq = ++seq.current;
    setIntrospecting(true);
    try {
      const qs = new URLSearchParams({ url });
      if (ref) qs.set("ref", ref);
      if (path && path !== "ocd-stack.json") qs.set("path", path);
      const res: StackIntrospectResult = await get(`/api/repos/introspect-stack?${qs.toString()}`);
      if (mySeq !== seq.current) return;
      setResult(res);
      if (res.ok) {
        setSpecs(res.apps.map((a) => ({ ...a.spec })));
        setServices(res.services.map((s) => ({ ...s })));
        setEnv(() => {
          const next: EnvState = {};
          for (const a of res.apps) {
            const vals: Record<string, string> = {};
            for (const d of a.env) vals[d.key] = d.default ?? "";
            next[a.spec.key] = vals;
          }
          return next;
        });
      }
    } catch (err: any) {
      if (mySeq !== seq.current) return;
      setResult({ ok: false, error: err?.message || "Couldn't read that repo." });
    } finally {
      if (mySeq === seq.current) setIntrospecting(false);
    }
  }, []);

  useEffect(() => {
    const url = repoUrl.trim();
    if (!url) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => runIntrospect(url, branch || undefined, stackPath.trim() || "ocd-stack.json"), 500);
    return () => clearTimeout(timer);
  }, [repoUrl, branch, stackPath, runIntrospect]);

  const ok = result?.ok ? result : null;

  const envDefsByKey = useMemo(() => {
    const m = new Map<string, StackEnvDef[]>();
    if (ok) for (const a of ok.apps) m.set(a.spec.key, a.env);
    return m;
  }, [ok]);

  const manifestPathByKey = useMemo(() => {
    const m = new Map<string, string>();
    if (ok) for (const a of ok.apps) m.set(a.spec.key, a.manifest_path);
    return m;
  }, [ok]);

  // Peer keys (apps + services) available as `needs` targets.
  const allKeys = useMemo(
    () => [...specs.map((s) => s.key), ...services.map((s) => s.key)],
    [specs, services],
  );

  const setEnvValue = (appKey: string, envKey: string, value: string) =>
    setEnv((s) => ({ ...s, [appKey]: { ...(s[appKey] || {}), [envKey]: value } }));

  const patchSpec = (i: number, patch: Partial<StackAppSpec>) =>
    setSpecs((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const patchService = (i: number, patch: Partial<StackServiceSpec>) =>
    setServices((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const missingRequired = useMemo(() => {
    const miss: string[] = [];
    for (const spec of specs) {
      for (const d of envDefsByKey.get(spec.key) ?? []) {
        if (d.required && !env[spec.key]?.[d.key]?.trim()) miss.push(`${spec.key}.${d.key}`);
      }
    }
    return miss;
  }, [specs, envDefsByKey, env]);

  const toggleApp = (key: string) =>
    setOpenApp((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const handleDeploy = async () => {
    if (!ok) return;
    if (missingRequired.length > 0) return showToast(`Required: ${missingRequired.join(", ")}`, "error");
    const deployBranch = branch || ok.default_branch;
    const apps: StackDeployBody["apps"] = specs.map((spec) => {
      const defs = envDefsByKey.get(spec.key) ?? [];
      const vals = env[spec.key] || {};
      const env_vars = defs
        .map((d) => ({ key: d.key, value: (vals[d.key] ?? "").trim(), secret: d.secret }))
        .filter((e) => e.value !== "");
      // Prune empty extra-volume rows before sending.
      const extra_volumes = spec.extra_volumes?.filter((v) => v.host_path && v.container_path);
      return {
        ...spec,
        git_branch: deployBranch,
        extra_volumes: extra_volumes && extra_volumes.length > 0 ? extra_volumes : undefined,
        env_vars: env_vars.length > 0 ? env_vars : undefined,
      };
    });
    const body: StackDeployBody = { name: ok.name, services, apps };

    setDeploying(true);
    try {
      const res = (await post("/api/stacks", body)) as { op_id?: number };
      if (!res?.op_id) throw new Error("No op_id returned");
      window.location.hash = `#/deploy/progress/${res.op_id}`;
    } catch (err: any) {
      showToast(err?.message || "Failed to enqueue stack deploy", "error");
      setDeploying(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Boxes size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Deploy Stack</h1>
      </div>
      <p className="text-fg-dim text-sm mb-5">
        Point at a repo with an <code className="font-mono text-[12px]">ocd-stack.json</code>. We resolve every app and service — tweak anything before deploying.
      </p>

      <DeployModeTabs active="stack" />

      <div className="border-2 border-fg bg-bg-raised shadow-neo divide-y-2 divide-fg">
        {/* Repo input */}
        <div className="p-5 space-y-3">
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block">GitHub repository</label>
          <div className="flex items-center gap-2">
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 bg-bg border-2 border-fg px-3 py-2 font-mono text-[12px] text-fg placeholder:text-muted focus:outline-none focus:bg-alt"
            />
            {introspecting && <Loader2 size={16} className="animate-spin text-fg-dim shrink-0" />}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted">Manifest</span>
              <input value={stackPath} onChange={(e) => setStackPath(e.target.value)} className={`${inputCls} w-56`} />
            </div>
            {ok && ok.branches.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted">Branch</span>
                <select value={branch || ok.default_branch} onChange={(e) => setBranch(e.target.value)} className={`${inputCls} cursor-pointer`}>
                  {ok.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {result && !result.ok && (
          <div className="px-5 py-4 flex items-start gap-2 text-accent-red">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="font-mono text-[11px]">{result.error}</span>
          </div>
        )}

        {ok && (
          <div className="p-5 space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <Boxes size={14} className="text-fg" />
                <span className="font-mono text-[13px] font-bold text-fg uppercase">{ok.name}</span>
              </div>
              {ok.description && <p className="font-mono text-[10px] text-muted mt-1">{ok.description}</p>}
            </div>

            {/* Services */}
            {services.length > 0 && (
              <div>
                <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-2">Services ({services.length})</div>
                <div className="space-y-2">
                  {services.map((s, i) => <ServiceRow key={s.key} svc={s} onChange={(p) => patchService(i, p)} />)}
                </div>
              </div>
            )}

            {/* Apps */}
            <div>
              <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-2">Apps ({specs.length})</div>
              <div className="space-y-4">
                {specs.map((spec, i) => {
                  const defs = envDefsByKey.get(spec.key) ?? [];
                  const isOpen = openApp.has(spec.key);
                  return (
                    <div key={spec.key} className="border-2 border-fg/15 p-3">
                      <div className="flex items-center gap-3 flex-wrap mb-1">
                        <Box size={12} className="text-muted shrink-0" />
                        <span className="font-mono text-[11px] font-bold text-fg uppercase">{spec.key}</span>
                        {spec.public === false && <span className="flex items-center gap-1 font-mono text-[9px] text-muted"><Lock size={9} /> private</span>}
                        {spec.domain && <span className="flex items-center gap-1 font-mono text-[9px] text-muted"><Globe size={9} /> {spec.domain}</span>}
                        {spec.needs && spec.needs.length > 0 && (
                          <span className="flex items-center gap-1 font-mono text-[9px] text-muted"><ArrowRight size={9} /> {spec.needs.join(", ")}</span>
                        )}
                        <button type="button" onClick={() => toggleApp(spec.key)} className="ml-auto inline-flex items-center gap-1 font-mono text-[9px] text-fg-dim hover:text-fg">
                          <Settings2 size={11} /> options {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        </button>
                      </div>
                      <div className="font-mono text-[9px] text-muted mb-2">{manifestPathByKey.get(spec.key)}</div>

                      {defs.length > 0 && (
                        <div className="space-y-1.5">
                          {defs.map((d) => (
                            <div key={d.key} className="flex items-center gap-2">
                              <label className="font-mono text-[10px] text-fg w-44 shrink-0 truncate" title={d.description || d.key}>
                                {d.key}{d.required && <span className="text-accent-red">*</span>}
                              </label>
                              <input
                                type={d.secret ? "password" : "text"}
                                value={env[spec.key]?.[d.key] ?? ""}
                                placeholder={d.required ? "required" : d.description || ""}
                                onChange={(e) => setEnvValue(spec.key, d.key, e.target.value)}
                                className={`${inputCls} flex-1`}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      {isOpen && (
                        <StackAppOptions
                          spec={spec}
                          peers={allKeys.filter((k) => k !== spec.key)}
                          onChange={(patch) => patchSpec(i, patch)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {ok.notes.length > 0 && (
              <ul className="font-mono text-[9px] text-muted list-disc pl-4 space-y-0.5">
                {ok.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="font-mono text-[10px] space-y-1 text-fg">
                <SummaryRow label="Stack" value={ok.name} />
                <SummaryRow label="Members" value={`${specs.length} app(s) · ${services.length} service(s)`} />
                <SummaryRow label="Branch" value={branch || ok.default_branch} />
              </div>
              <Btn
                variant="primary"
                size="sm"
                onClick={handleDeploy}
                loading={deploying}
                disabled={deploying || missingRequired.length > 0}
                title={missingRequired.length > 0 ? `Fill required: ${missingRequired.join(", ")}` : undefined}
              >
                <CheckCircle2 size={14} /> Deploy stack
              </Btn>
            </div>
          </div>
        )}

        {introspecting && !result && <div className="flex justify-center py-10"><Spinner /></div>}
      </div>
    </div>
  );
}
