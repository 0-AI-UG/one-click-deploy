import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Card, Btn, showToast, confirm, confirmWithText, EmptyState, PageShell, PageHeader, SectionHeader } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Layers, Plus, Trash2, Copy, ChevronDown, ChevronRight, Key } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

type AttachedApp = { id: number; name: string; status: string; domain: string };
export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [deletedEnvironments, setDeletedEnvironments] = useState<EnvironmentData[]>([]);
  const [expanded, setExpanded] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [rollout, setRollout] = useState<"restart" | "none">("restart");
  const [loading, setLoading] = useState(false);
  const [attachedApps, setAttachedApps] = useState<Record<number, AttachedApp[]>>({});
  // Inline "copy an environment" bar (source picker + new-name input), opened
  // from the header Copy button. null = closed.
  const [copy, setCopy] = useState<{ sourceId: number | null; name: string } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const copyPopoverRef = useRef<HTMLDivElement>(null);

  // Close the copy popover on an outside click — but ignore clicks in the
  // NeoSelect menu, which is portaled to document.body (outside the ref).
  useEffect(() => {
    if (!copy) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (copyPopoverRef.current && !copyPopoverRef.current.contains(target) && !target.closest("[data-neoselect-menu]")) {
        setCopy(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [copy]);

  const ops = useActiveOperations(
    (op) => op.kind === "cascade_redeploy",
    { rehydrateToasts: true },
  );

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
    get("/api/environments/deleted").then(setDeletedEnvironments).catch(() => {});
  };

  useEffect(load, []);

  // Load attached apps for all environments
  useEffect(() => {
    for (const env of environments) {
      get(`/api/environments/${env.id}/apps`)
        .then((apps: AttachedApp[]) => {
          setAttachedApps((prev) => ({ ...prev, [env.id]: apps }));
        })
        .catch(() => {});
    }
  }, [environments]);

  const toggle = (env: EnvironmentData) => {
    if (expanded === env.id) {
      setExpanded(null);
    } else {
      setExpanded(env.id);
      setEditName(env.name);
      setEditVars(env.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret })));
      setRollout("restart");
    }
  };

  const startNew = () => {
    setExpanded("new");
    setEditName("");
    setEditVars([]);
    setRollout("restart");
  };

  const save = async (id: number | "new") => {
    setLoading(true);
    try {
      const rows = editVars.filter((e) => e.key.trim());
      const vars = rows.filter((entry) => !entry.secret).map((entry) => `${entry.key.trim()}=${entry.value}`);
      const secretVars = rows.filter((entry) => entry.secret).map((entry) => `${entry.key.trim()}=${entry.value}`);
      if (id === "new") {
        await runCliAction("envs.create", { name: editName, vars, secretVars });
        showToast("Environment created", "success");
      } else {
        const apps = attachedApps[id] || [];
        const activeApps = apps.filter((a) => a.status !== "stopped" && a.status !== "destroying");
        if (activeApps.length > 0 && rollout !== "none") {
          const ok = await confirm(
            "Reload Apps",
            `Saving will recreate ${activeApps.length} app(s) from their existing immutable images: ${activeApps.map((a) => a.name).join(", ")}`,
            true,
          );
          if (!ok) { setLoading(false); return; }
        }
        const existing = environments.find((environment) => environment.id === id);
        if (existing && existing.name !== editName.trim()) {
          await runCliAction("envs.rename", {
            environment: String(id),
            newName: editName.trim(),
          });
        }
        if (rows.length > 0) {
          await runCliAction("envs.set", {
            environment: String(id),
            vars,
            secretVars,
            replace: true,
            rollout,
          });
        } else if ((existing?.env_vars.length ?? 0) > 0) {
          await runCliAction("envs.unset", {
            environment: String(id),
            keys: existing!.env_vars.map((entry) => entry.key),
            rollout,
          });
        } else {
          showToast("Environment updated", "success");
        }
        showToast("Environment updated", "success");
      }
      setExpanded(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  const startCopy = () => {
    setExpanded(null);
    const src = environments[0] ?? null;
    setCopy({ sourceId: src?.id ?? null, name: src ? `${src.name}-copy` : "" });
  };

  // When the source changes, pre-fill the name with "<source>-copy" unless the
  // user has already typed a custom name.
  const pickCopySource = (id: number | null) => {
    setCopy((c) => {
      if (!c) return c;
      const src = environments.find((e) => e.id === id);
      const prevSrc = environments.find((e) => e.id === c.sourceId);
      const untouched = c.name === "" || c.name === (prevSrc ? `${prevSrc.name}-copy` : "");
      return { sourceId: id, name: untouched && src ? `${src.name}-copy` : c.name };
    });
  };

  const doCopy = async () => {
    if (!copy?.sourceId || !copy.name.trim()) return;
    setCopyBusy(true);
    try {
      await runCliAction("envs.copy", {
        environment: String(copy.sourceId),
        newName: copy.name.trim(),
      });
      showToast("Environment duplicated", "success");
      setCopy(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to duplicate", "error");
    } finally {
      setCopyBusy(false);
    }
  };

  const renderEditor = (id: number | "new") => {
    const envBusy = typeof id === "number" && !!ops.byResourceKey(`env:${id}`);
    return (
      <div className="px-4 pb-3 pt-1 ml-7 space-y-3">
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Environment name"
          className="!text-[10px] font-bold uppercase"
          autoFocus
        />
        {/* Env var values are credentials, so they sit behind their own grant
            rather than the environment lifecycle one. */}
        <PermissionGate
          permission="environments.secrets"
          environmentId={typeof id === "number" ? id : undefined}
          fallback={
            <p className="font-mono text-[9px] text-muted uppercase tracking-wider">
              Env vars hidden — requires environments.secrets
            </p>
          }
        >
          <EnvVarEditor entries={editVars} onChange={setEditVars} />
        </PermissionGate>
        {typeof id === "number" && (
          <div className="grid grid-cols-[120px_1fr] items-center gap-2">
            <span className="font-mono text-[9px] font-bold uppercase text-muted">Apply changes</span>
            <NeoSelect
              compact
              value={rollout}
              options={[
                { value: "restart", label: "Reload running apps now" },
                { value: "none", label: "Apply on next deploy" },
              ]}
              onChange={(value) => setRollout((value || "restart") as typeof rollout)}
            />
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Btn size="xs" variant="ghost" onClick={() => setExpanded(null)}>Cancel</Btn>
          <Btn size="xs" variant="primary" loading={loading || envBusy} disabled={!editName.trim() || envBusy} onClick={() => save(id)}>
            {id === "new" ? "Create" : envBusy ? "Rolling out…" : "Save"}
          </Btn>
        </div>
      </div>
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="Environments"
        description="Reusable variables and secrets projected into app deployments."
        actions={<>
          {environments.length > 0 && (
            <div className="relative" ref={copyPopoverRef}>
              <Btn size="sm" variant="ghost" onClick={() => (copy ? setCopy(null) : startCopy())}>
                <Copy size={12} /> Copy
              </Btn>
              {copy && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-bg-raised border-2 border-fg shadow-neo p-3 space-y-2 w-56">
                  <NeoSelect
                    compact
                    value={copy.sourceId != null ? String(copy.sourceId) : ""}
                    placeholder="Environment to copy"
                    options={environments.map((e) => ({ value: String(e.id), label: e.name }))}
                    onChange={(v) => pickCopySource(v ? parseInt(v) : null)}
                  />
                  <input
                    type="text"
                    value={copy.name}
                    onChange={(e) => setCopy((c) => (c ? { ...c, name: e.target.value } : c))}
                    onKeyDown={(e) => { if (e.key === "Enter") doCopy(); if (e.key === "Escape") setCopy(null); }}
                    placeholder="New environment name"
                    className="w-full !text-[10px] font-bold uppercase"
                    autoFocus
                  />
                  <div className="flex gap-2 justify-end">
                    <Btn size="xs" variant="ghost" onClick={() => setCopy(null)}>Cancel</Btn>
                    <Btn size="xs" variant="primary" loading={copyBusy} disabled={!copy.sourceId || !copy.name.trim() || copyBusy} onClick={doCopy}>
                      Duplicate
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          <Btn size="sm" variant="primary" onClick={startNew}>
            <Plus size={12} /> New
          </Btn>
        </>}
      />

      {environments.length > 0 || expanded === "new" ? (
        <Card className="overflow-hidden">
          <div className="divide-y divide-fg/10">
            {expanded === "new" && (
              <div>
                <div className="px-4 py-3 flex items-center gap-3 bg-alt/30">
                  <ChevronDown size={12} className="text-muted flex-shrink-0" />
                  <span className="font-mono text-[10px] font-bold text-fg uppercase">New Environment</span>
                </div>
                {renderEditor("new")}
              </div>
            )}
            {environments.map((env) => {
              const isOpen = expanded === env.id;
              const apps = attachedApps[env.id] || [];
              return (
                <div key={env.id}>
                  <div
                    className="px-4 py-3 flex items-center justify-between hover:bg-alt/50 transition-colors cursor-pointer"
                    onClick={() => toggle(env)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isOpen
                        ? <ChevronDown size={12} className="text-muted flex-shrink-0" />
                        : <ChevronRight size={12} className="text-muted flex-shrink-0" />
                      }
                      <span className="font-mono text-[10px] font-bold text-fg uppercase">{env.name}</span>
                      <span className="font-mono text-[9px] text-muted flex items-center gap-1">
                        <Key size={9} /> {env.env_vars.length}
                      </span>
                      {apps.length > 0 && (
                        <span className="font-mono text-[9px] text-muted">
                          {apps.length} app{apps.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Btn
                        size="xs"
                        variant="ghost"
                        title="Delete"
                        onClick={async () => {
                          if (apps.length > 0) {
                            showToast(`Cannot delete: used by ${apps.map((a) => a.name).join(", ")}`, "error");
                            return;
                          }
                          if (await confirm("Delete Environment", `Delete "${env.name}"?`, true)) {
                            try {
                              await runConfirmedCliAction(
                                "envs.delete",
                                { environment: String(env.id) },
                                { action: "delete_environment", resourceType: "environment", resourceId: env.id },
                              );
                              showToast("Environment retained for recovery", "success");
                              load();
                            } catch (err: any) {
                              showToast(err.message || "Failed to delete", "error");
                            }
                          }
                        }}
                      >
                        <Trash2 size={12} className="text-accent-red" />
                      </Btn>
                    </div>
                  </div>
                  {isOpen && (
                    <>
                      <div className="px-4 py-2 ml-7 flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[9px] text-muted uppercase">Apps:</span>
                        {apps.map((a) => (
                          <span key={a.id} className="inline-flex items-center gap-1 font-mono text-[9px] px-1.5 py-0.5 bg-alt text-fg">
                            <a href={`#/apps/${a.id}`} className="hover:underline">{a.name}</a>
                          </span>
                        ))}
                        {apps.length === 0 && <span className="font-mono text-[9px] text-muted">no apps</span>}
                      </div>
                      {renderEditor(env.id)}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <EmptyState message="No environments yet" icon={Layers} />
      )}

      {deletedEnvironments.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader className="bg-alt/30 px-4 py-3" title="Deleted environments" description="Recoverable configuration retained separately from apps and stacks." />
          <div className="divide-y divide-fg/10">
            {deletedEnvironments.map((environment) => (
              <div key={environment.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] font-bold text-fg uppercase">{environment.name}</div>
                  <div className="font-mono text-[9px] text-muted">
                    Recovery-protected until {environment.purge_after || "the recovery window ends"}. Purge here can override protection.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Btn
                    size="xs"
                    variant="ghost"
                    title="Restore environment"
                    onClick={async () => {
                      try {
                        await runCliAction("envs.restore", { environment: String(environment.id) });
                        showToast("Environment restored", "success");
                        load();
                      } catch (err: any) {
                        showToast(err.message || "Failed to restore", "error");
                      }
                    }}
                  >
                    Restore
                  </Btn>
                  <Btn
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      if (!await confirmWithText(
                        "Permanently Delete Environment",
                        `Permanently delete "${environment.name}" and all its variables? This cannot be undone.`,
                        environment.name,
                        `Type ${environment.name} to confirm`,
                      )) return;
                      try {
                        await runConfirmedCliAction(
                          "envs.purge",
                          { environment: String(environment.id) },
                          {
                            action: "purge_environment",
                            resourceType: "environment",
                            resourceId: environment.id,
                            typedResource: environment.name,
                          },
                        );
                        showToast("Environment permanently deleted", "success");
                        load();
                      } catch (err: any) {
                        showToast(err.message || "Failed to purge", "error");
                      }
                    }}
                  >
                    <Trash2 size={12} className="text-accent-red" /> Purge
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </PageShell>
  );
}
