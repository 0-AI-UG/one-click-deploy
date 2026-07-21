import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { get, put } from "../../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../../components/ui.tsx";
import { ArrowLeft, Save, Key, ShieldCheck, Target, X } from "lucide-react";
import { useAuth } from "../../stores/auth.ts";
import type { AdminUser, AppData, EnvironmentData, PermissionGrant, UserPermissionsResponse } from "../../types.ts";

// Mirrors the sections of ALL_PERMISSIONS in shared/db/users.ts. Every
// permission in that catalog appears here exactly once; the save path posts
// whatever the server sent as `allPermissions`, so a permission added there but
// missed here would still round-trip, just without a checkbox.
const PERMISSION_GROUPS: Array<{ label: string; permissions: Array<{ key: string; label: string }> }> = [
  {
    label: "Client Access",
    permissions: [
      { key: "cli.access", label: "Use the ocd CLI at all" },
    ],
  },
  {
    label: "Read",
    permissions: [
      { key: "fleet.view", label: "View servers, topology, dashboard" },
      { key: "apps.view", label: "View apps" },
      { key: "services.view", label: "View services" },
      { key: "environments.view", label: "View environments (not their values)" },
      { key: "metrics.view", label: "View replicas, metrics, scaling events" },
      { key: "operations.view", label: "View engine operations" },
      { key: "deployments.view", label: "View deployment history and deploy logs" },
    ],
  },
  {
    label: "Apps",
    permissions: [
      { key: "apps.deploy", label: "Deploy new apps" },
      { key: "apps.redeploy", label: "Redeploy existing apps" },
      { key: "apps.rollback", label: "Rollback deployments" },
      { key: "apps.restart", label: "Restart containers" },
      { key: "apps.pause", label: "Pause/unpause apps" },
      { key: "apps.destroy", label: "Destroy apps" },
      { key: "apps.logs", label: "View app logs" },
      { key: "apps.rename", label: "Rename apps" },
      { key: "apps.promote", label: "Promote staging to production" },
      { key: "apps.ingress", label: "Auth, sticky, rate limit, allowlist, health check" },
      { key: "apps.expose", label: "Publish an app on a public fleet port" },
      { key: "webhooks.manage", label: "Enable/disable deploy webhooks" },
    ],
  },
  {
    label: "Services",
    permissions: [
      { key: "services.deploy", label: "Deploy infrastructure services" },
      { key: "services.manage", label: "Restart/pause/unpause services" },
      { key: "services.destroy", label: "Destroy services" },
      { key: "services.logs", label: "View service logs" },
      { key: "services.link", label: "Link/unlink services to environments" },
    ],
  },
  {
    label: "Stacks",
    permissions: [
      { key: "stacks.view", label: "View stacks" },
      { key: "stacks.deploy", label: "Deploy/redeploy stacks" },
      { key: "stacks.settings", label: "Edit stack settings (staging environment)" },
      { key: "stacks.promote", label: "Promote a stack's staging members" },
      { key: "stacks.destroy", label: "Destroy stacks" },
    ],
  },
  {
    label: "Environments",
    permissions: [
      { key: "environments.manage", label: "Create/edit/delete environments, attach apps" },
      { key: "environments.secrets", label: "Read/write env var values (secrets)" },
    ],
  },
  {
    label: "Scaling",
    permissions: [
      { key: "scaling.scale", label: "Manual scale and wake" },
      { key: "scaling.policy", label: "Edit the autoscaling policy" },
      { key: "scaling.migrate", label: "Migrate replicas between servers" },
    ],
  },
  {
    label: "Servers",
    permissions: [
      { key: "servers.create", label: "Create servers" },
      { key: "servers.manage", label: "Manage servers and pool assignment" },
      { key: "servers.delete", label: "Delete servers" },
    ],
  },
  {
    label: "Volumes",
    permissions: [
      { key: "volumes.create", label: "Create volumes" },
      { key: "volumes.attach", label: "Attach volumes to apps" },
      { key: "volumes.detach", label: "Detach volumes" },
      { key: "volumes.resize", label: "Resize volumes" },
      { key: "volumes.delete", label: "Delete volumes" },
      { key: "volumes.files.read", label: "Browse and read files on a volume" },
    ],
  },
  {
    label: "Cloud Resources",
    permissions: [
      { key: "resources.view", label: "View the resources summary" },
      { key: "resources.delete", label: "Delete orphan resources" },
    ],
  },
  {
    label: "Operations",
    permissions: [
      { key: "operations.cancel", label: "Cancel a running engine operation" },
    ],
  },
  {
    label: "Control Plane",
    permissions: [
      { key: "panel.view", label: "View panel status, logs and deployments" },
      { key: "panel.manage", label: "Redeploy the panel, manage its webhook" },
    ],
  },
  {
    label: "Terminal",
    permissions: [
      { key: "terminal.container", label: "Shell into a container" },
      { key: "terminal.host", label: "Shell on a fleet host (root-equivalent)" },
    ],
  },
];

const grantKey = (g: PermissionGrant) => `${g.permission}|${g.scopeType}|${g.scopeId ?? ""}`;

type ScopeKind = "environment" | "app";
type ScopeKindMap = Record<string, ScopeKind[]>;

/** Human blurb for a permission key, taken from the groups above. */
function permissionLabel(key: string): string {
  for (const group of PERMISSION_GROUPS) {
    const hit = group.permissions.find((p) => p.key === key);
    if (hit) return hit.label;
  }
  return "";
}

export function UserDetailPage({ userId }: { userId: string }) {
  const auth = useAuth();
  const isSelf = auth.user?.id === userId;
  const [user, setUser] = useState<AdminUser | null>(null);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  // Per-permission scope kinds, straight from the server's PERMISSION_SCOPES
  // (shared/db/users.ts). Absent permission => global-only, no scope button.
  const [scopeKinds, setScopeKinds] = useState<ScopeKindMap>({});
  const [apps, setApps] = useState<AppData[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  // At most one scope modal at a time; holds the permission key.
  const [scopeOpen, setScopeOpen] = useState<string | null>(null);
  // The button that opened the modal, so focus can be handed back on close.
  const scopeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    Promise.all([
      get("/api/admin/users"),
      get(`/api/admin/users/${userId}/permissions`),
    ]).then(([usersRes, permRes]: [{ users: AdminUser[] }, UserPermissionsResponse]) => {
      setUser(usersRes.users.find((u) => u.id === userId) ?? null);
      // Older servers only send `permissions`; treat those as global grants.
      setGrants(
        permRes.grants ??
          (permRes.permissions || []).map((p) => ({ permission: p, scopeType: "global" as const, scopeId: null })),
      );
      // Older servers predate `scopeKinds`; fall back to their flat scopable
      // list, which had no per-permission kinds to offer.
      setScopeKinds(
        permRes.scopeKinds ??
          Object.fromEntries(
            (permRes.scopablePermissions || []).map((p) => [p, ["environment", "app"] as ScopeKind[]]),
          ),
      );
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
  }, [userId]);

  // Scope pickers; harmless to fetch even for an admin (whose grants are fixed).
  useEffect(() => {
    get("/api/apps").then(setApps).catch(() => {});
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  const isGlobal = (perm: string) => grants.some((g) => g.permission === perm && g.scopeType === "global");
  const scopedOf = (perm: string) => grants.filter((g) => g.permission === perm && g.scopeType !== "global");

  const toggleGlobal = (perm: string) => {
    setGrants((prev) =>
      isGlobal(perm)
        ? prev.filter((g) => !(g.permission === perm && g.scopeType === "global"))
        : [...prev, { permission: perm, scopeType: "global", scopeId: null }],
    );
  };

  const toggleScoped = (perm: string, scopeType: "app" | "environment", scopeId: number) => {
    const target: PermissionGrant = { permission: perm, scopeType, scopeId: String(scopeId) };
    setGrants((prev) =>
      prev.some((g) => grantKey(g) === grantKey(target))
        ? prev.filter((g) => grantKey(g) !== grantKey(target))
        : [...prev, target],
    );
  };

  const removeScoped = (g: PermissionGrant) =>
    setGrants((prev) => prev.filter((x) => grantKey(x) !== grantKey(g)));

  const selectAllInGroup = (group: typeof PERMISSION_GROUPS[0]) => {
    const keys = group.permissions.map((p) => p.key);
    const allSelected = keys.every((k) => isGlobal(k));
    setGrants((prev) => {
      const withoutGroupGlobals = prev.filter(
        (g) => !(g.scopeType === "global" && keys.includes(g.permission)),
      );
      return allSelected
        ? withoutGroupGlobals
        : [
            ...withoutGroupGlobals,
            ...keys.map((k) => ({ permission: k, scopeType: "global" as const, scopeId: null })),
          ];
    });
  };

  const scopeLabel = (g: PermissionGrant): string => {
    if (g.scopeType === "app") {
      return apps.find((a) => String(a.id) === g.scopeId)?.name ?? `app#${g.scopeId}`;
    }
    return environments.find((e) => String(e.id) === g.scopeId)?.name ?? `env#${g.scopeId}`;
  };

  const saveGrants = async () => {
    setSaving(true);
    try {
      await put(`/api/admin/users/${userId}`, { grants });
      showToast("Permissions saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (!newPassword || newPassword.length < 8) return showToast("Password must be at least 8 characters", "error");
    setSavingPassword(true);
    try {
      await put(`/api/admin/users/${userId}`, { password: newPassword });
      showToast("Password updated", "success");
      setNewPassword("");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (!user) return <div className="text-center py-20 text-muted font-mono text-[10px] uppercase tracking-wider">User not found</div>;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/admin"; }}><ArrowLeft size={14} /></Btn>
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">{user.username}</h1>
          <p className="text-[9px] text-muted font-mono mt-0.5 uppercase tracking-wider">
            {user.isAdmin ? "Admin; has all permissions" : "User; permissions managed below"}
          </p>
        </div>
        {user.isAdmin && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase bg-accent-amber border-2 border-fg px-2 py-1 text-fg shadow-neo-sm">
            <ShieldCheck size={12} /> Admin
          </span>
        )}
      </div>

      {/* Permissions */}
      {!user.isAdmin && (
        <Card className="p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key size={14} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Permissions</h3>
            </div>
            <Btn variant="primary" loading={saving} onClick={saveGrants}><Save size={13} /> Save</Btn>
          </div>
          <p className="font-mono text-[8px] text-muted mb-4 leading-relaxed">
            Tick a permission to grant it fleet-wide. For the ones marked scopable, use
            <span className="text-fg font-bold"> Scope </span>
            to grant it on individual apps or environments instead — a fleet-wide tick supersedes those.
          </p>
          <div className="space-y-6">
            {PERMISSION_GROUPS.map((group) => {
              const allSelected = group.permissions.every((p) => isGlobal(p.key));
              return (
                <div key={group.label}>
                  <div className="flex items-center justify-between mb-2 border-b-2 border-fg pb-2">
                    <span className="font-mono text-[9px] text-accent-blue font-bold uppercase tracking-wider">{group.label}</span>
                    <button
                      onClick={() => selectAllInGroup(group)}
                      className="font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-2 py-0.5 bg-bg-raised text-fg-dim shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none transition-all"
                    >
                      {allSelected ? "Deselect All" : "Select All"}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {group.permissions.map((perm) => {
                      const checked = isGlobal(perm.key);
                      const scoped = scopedOf(perm.key);
                      const kinds = scopeKinds[perm.key] ?? [];
                      const open = scopeOpen === perm.key;
                      return (
                        <div
                          key={perm.key}
                          className={`border-2 border-fg shadow-neo-sm ${checked ? "bg-accent/20" : "bg-bg-raised"}`}
                        >
                          <div className="flex items-center gap-2.5 px-3 py-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleGlobal(perm.key)}
                              className="flex-shrink-0"
                              id={`perm-${perm.key}`}
                            />
                            <label htmlFor={`perm-${perm.key}`} className="cursor-pointer min-w-0 flex-1">
                              <span className="font-mono text-[9px] text-fg font-bold uppercase">{perm.key}</span>
                              <span className="block font-mono text-[8px] text-muted">{perm.label}</span>
                            </label>
                            {/* Only permissions the server reports as scopable
                                get an affordance at all; the modal keeps the
                                row's height fixed however many scopes exist. */}
                            {kinds.length > 0 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  scopeTriggerRef.current = e.currentTarget;
                                  setScopeOpen(perm.key);
                                }}
                                title="Grant on individual apps or environments"
                                aria-haspopup="dialog"
                                aria-expanded={open}
                                className={`flex-shrink-0 flex items-center gap-1 font-mono text-[8px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5 shadow-neo-sm transition-all ${
                                  scoped.length > 0 ? "bg-accent text-fg" : "bg-bg-raised text-fg-dim hover:bg-alt"
                                }`}
                              >
                                <Target size={9} />
                                {scoped.length > 0 ? `Scoped · ${scoped.length}` : "Scope"}
                              </button>
                            )}
                          </div>

                          {/* Existing narrower grants. A global tick makes them
                              redundant, so they are struck through rather than
                              silently dropped — untick global and they apply again. */}
                          {scoped.length > 0 && (
                            <div className="px-3 pb-2">
                              <ScopeChips
                                grants={scoped}
                                superseded={checked}
                                label={scopeLabel}
                                onRemove={removeScoped}
                              />
                            </div>
                          )}

                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {scopeOpen && (
        <ScopeModal
          permission={scopeOpen}
          description={permissionLabel(scopeOpen)}
          kinds={scopeKinds[scopeOpen] ?? []}
          isGlobal={isGlobal(scopeOpen)}
          scoped={scopedOf(scopeOpen)}
          apps={apps}
          environments={environments}
          scopeLabel={scopeLabel}
          onToggle={(kind, id) => toggleScoped(scopeOpen, kind, id)}
          onRemove={removeScoped}
          onClose={() => {
            setScopeOpen(null);
            scopeTriggerRef.current?.focus();
            scopeTriggerRef.current = null;
          }}
        />
      )}

      {/* Reset Password — hidden when viewing yourself; use the change-password card on the user list page instead. */}
      {!isSelf && (
        <Card className="p-5">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Reset Password</h3>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 8 chars)" />
            </div>
            <Btn variant="default" loading={savingPassword} onClick={resetPassword}>Update Password</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Existing narrower grants. A global tick makes them redundant, so they are
 *  struck through rather than silently dropped — untick global and they apply
 *  again. Rendered both on the row and inside the modal. */
function ScopeChips({ grants, superseded, label, onRemove }: {
  grants: PermissionGrant[];
  superseded: boolean;
  label: (g: PermissionGrant) => string;
  onRemove: (g: PermissionGrant) => void;
}) {
  return (
    <div className={`flex flex-wrap gap-1 ${superseded ? "opacity-40" : ""}`}>
      {grants.map((g) => (
        <span
          key={grantKey(g)}
          className={`inline-flex items-center gap-1 font-mono text-[8px] font-bold uppercase border border-fg px-1 py-0.5 bg-alt ${superseded ? "line-through" : ""}`}
          title={superseded ? "Superseded by the fleet-wide grant" : undefined}
        >
          {g.scopeType === "app" ? "app" : "env"}:{label(g)}
          <button type="button" onClick={() => onRemove(g)} className="text-muted hover:text-accent-red">
            <X size={9} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Scope picker, portalled to <body> so opening it never resizes the
 *  permission row it belongs to. Only the scope kinds the server says are
 *  meaningful for this permission get a section. */
function ScopeModal({
  permission, description, kinds, isGlobal, scoped, apps, environments, scopeLabel, onToggle, onRemove, onClose,
}: {
  permission: string;
  description: string;
  kinds: ScopeKind[];
  isGlobal: boolean;
  scoped: PermissionGrant[];
  apps: AppData[];
  environments: EnvironmentData[];
  scopeLabel: (g: PermissionGrant) => string;
  onToggle: (kind: ScopeKind, id: number) => void;
  onRemove: (g: PermissionGrant) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Background must not scroll underneath the dialog.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-fg/40 animate-fade-in p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Scope ${permission}`}
        className="bg-bg-raised border-2 border-fg shadow-neo w-full max-w-lg max-h-[80vh] flex flex-col animate-slide-up"
      >
        <div className="flex items-start gap-3 border-b-2 border-fg px-4 py-3">
          <Target size={14} className="text-fg mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[10px] text-fg font-bold uppercase tracking-wider break-all">{permission}</h3>
            {description && <p className="font-mono text-[8px] text-muted mt-0.5">{description}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex-shrink-0 border-2 border-fg bg-bg-raised text-fg-dim px-1.5 py-1 shadow-neo-sm hover:bg-alt active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none transition-all"
          >
            <X size={12} />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3">
          {isGlobal && (
            <p className="font-mono text-[8px] text-muted uppercase tracking-wider border-2 border-fg bg-alt px-2 py-1">
              Granted fleet-wide; scopes below are ignored until you untick it.
            </p>
          )}
          {kinds.includes("environment") && (
            <ScopeList
              title="Environments"
              items={environments.map((e) => ({ id: e.id, name: e.name }))}
              selected={scoped.filter((g) => g.scopeType === "environment").map((g) => g.scopeId)}
              onToggle={(id) => onToggle("environment", id)}
            />
          )}
          {kinds.includes("app") && (
            <ScopeList
              title="Apps"
              items={apps.map((a) => ({ id: a.id, name: a.name }))}
              selected={scoped.filter((g) => g.scopeType === "app").map((g) => g.scopeId)}
              onToggle={(id) => onToggle("app", id)}
            />
          )}
          {scoped.length > 0 && (
            <div>
              <div className="font-mono text-[8px] text-muted font-bold uppercase tracking-wider mb-1">Granted on</div>
              <ScopeChips grants={scoped} superseded={isGlobal} label={scopeLabel} onRemove={onRemove} />
            </div>
          )}
        </div>

        <div className="border-t-2 border-fg px-4 py-2 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg bg-accent text-fg px-3 py-1 shadow-neo-sm hover:bg-accent/80 active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none transition-all"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ScopeList({ title, items, selected, onToggle }: {
  title: string;
  items: Array<{ id: number; name: string }>;
  selected: Array<string | null>;
  onToggle: (id: number) => void;
}) {
  return (
    <div>
      <div className="font-mono text-[8px] text-muted font-bold uppercase tracking-wider mb-1">{title}</div>
      {items.length === 0 ? (
        <div className="font-mono text-[8px] text-muted">none</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((it) => {
            const on = selected.includes(String(it.id));
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => onToggle(it.id)}
                className={`font-mono text-[8px] font-bold uppercase border-2 border-fg px-1.5 py-0.5 transition-all ${
                  on ? "bg-accent text-fg shadow-neo-sm" : "bg-bg-raised text-fg-dim hover:bg-alt"
                }`}
              >
                {it.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
