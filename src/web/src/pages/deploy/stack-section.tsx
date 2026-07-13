import { useState, useEffect, useMemo } from "react";
import {
  Box, Database, Globe, Lock, ArrowRight, ChevronDown, ChevronRight,
  Settings2, Plus, X,
} from "lucide-react";
import { StackAppOptions } from "./stack-app-options.tsx";
import type { StackPayload } from "./types.ts";
import type {
  StackAppSpec, StackServiceSpec, StackEnvDef, StackDeployBody,
} from "../../types.ts";

// Per-app env values: appKey -> (envKey -> value)
type EnvState = Record<string, Record<string, string>>;

const inputCls =
  "bg-bg border-2 border-fg/40 px-2 py-1 font-mono text-[11px] text-fg placeholder:text-muted focus:outline-none focus:border-fg";

// --- useStackForm ------------------------------------------------------------
// Owns the editable stack (services + app specs + per-app env), seeded from the
// resolved introspect payload. Reseeds whenever a new stack is resolved (new
// repo / branch / manifest → fresh `stack` object). Returns everything the
// presentational <StackSection/> needs, plus `missingRequired` / `buildBody` so
// the shared deploy receipt/button in the Deploy page can drive the submit.
export type StackForm = ReturnType<typeof useStackForm>;

export function useStackForm(stack: StackPayload | null, branch: string) {
  const [specs, setSpecs] = useState<StackAppSpec[]>([]);
  const [services, setServices] = useState<StackServiceSpec[]>([]);
  const [env, setEnv] = useState<EnvState>({});
  const [openApp, setOpenApp] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!stack) {
      setSpecs([]);
      setServices([]);
      setEnv({});
      return;
    }
    setSpecs(stack.apps.map((a) => ({ ...a.spec })));
    setServices(stack.services.map((s) => ({ ...s })));
    setEnv(() => {
      const next: EnvState = {};
      for (const a of stack.apps) {
        const vals: Record<string, string> = {};
        for (const d of a.env) vals[d.key] = d.default ?? "";
        next[a.spec.key] = vals;
      }
      return next;
    });
  }, [stack]);

  const envDefsByKey = useMemo(() => {
    const m = new Map<string, StackEnvDef[]>();
    if (stack) for (const a of stack.apps) m.set(a.spec.key, a.env);
    return m;
  }, [stack]);

  const manifestPathByKey = useMemo(() => {
    const m = new Map<string, string>();
    if (stack) for (const a of stack.apps) m.set(a.spec.key, a.manifest_path);
    return m;
  }, [stack]);

  // Peer keys (apps + services) available as `needs` targets.
  const allKeys = useMemo(
    () => [...specs.map((s) => s.key), ...services.map((s) => s.key)],
    [specs, services],
  );

  const missingRequired = useMemo(() => {
    const miss: string[] = [];
    for (const spec of specs) {
      for (const d of envDefsByKey.get(spec.key) ?? []) {
        if (d.required && !env[spec.key]?.[d.key]?.trim()) miss.push(`${spec.key}.${d.key}`);
      }
    }
    return miss;
  }, [specs, envDefsByKey, env]);

  const setEnvValue = (appKey: string, envKey: string, value: string) =>
    setEnv((s) => ({ ...s, [appKey]: { ...(s[appKey] || {}), [envKey]: value } }));

  const patchSpec = (i: number, patch: Partial<StackAppSpec>) =>
    setSpecs((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const patchService = (i: number, patch: Partial<StackServiceSpec>) =>
    setServices((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const toggleApp = (key: string) =>
    setOpenApp((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const buildBody = (): StackDeployBody => {
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
        git_branch: branch || undefined,
        extra_volumes: extra_volumes && extra_volumes.length > 0 ? extra_volumes : undefined,
        env_vars: env_vars.length > 0 ? env_vars : undefined,
      };
    });
    return { name: stack?.name ?? "", services, apps };
  };

  return {
    specs, services, env, openApp,
    envDefsByKey, manifestPathByKey, allKeys, missingRequired,
    setEnvValue, patchSpec, patchService, toggleApp, buildBody,
  };
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

// --- StackSection ------------------------------------------------------------
// The stack member editor, rendered inside the shared Deploy-page left card so
// it reads the same as the single-app form. Services + apps groups; each app is
// a compact card with its required env inline and full options behind a toggle.
export function StackSection({ form }: { form: StackForm }) {
  const {
    specs, services, env, openApp,
    envDefsByKey, manifestPathByKey, allKeys,
    setEnvValue, patchSpec, patchService, toggleApp,
  } = form;

  return (
    <div className="p-5 space-y-5">
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
    </div>
  );
}
