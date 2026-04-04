import { useState, useEffect } from "react";
import { get, put } from "../../api/client.ts";
import { Card, Btn, Spinner, showToast } from "../../components/ui.tsx";
import { ArrowLeft, Save, Key, ShieldCheck } from "lucide-react";

const PERMISSION_GROUPS = [
  {
    label: "Settings",
    permissions: [{ key: "settings.manage", label: "Manage API keys, DNS, defaults" }],
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
      { key: "apps.logs", label: "View logs" },
      { key: "apps.env", label: "View/update env vars" },
    ],
  },
  {
    label: "Servers",
    permissions: [
      { key: "servers.view", label: "View server list" },
      { key: "servers.delete", label: "Delete servers" },
    ],
  },
  {
    label: "Volumes",
    permissions: [
      { key: "volumes.create", label: "Create/attach volumes" },
      { key: "volumes.manage", label: "Detach/resize volumes" },
      { key: "volumes.delete", label: "Delete volumes" },
    ],
  },
  {
    label: "Scaling",
    permissions: [{ key: "scaling.manage", label: "Scale apps, autoscaling policy" }],
  },
  {
    label: "Webhooks",
    permissions: [{ key: "webhooks.manage", label: "Enable/disable webhooks" }],
  },
  {
    label: "Resources",
    permissions: [
      { key: "resources.view", label: "View resources summary" },
      { key: "resources.delete", label: "Delete orphan resources" },
    ],
  },
];

export function UserDetailPage({ userId }: { userId: string }) {
  const [user, setUser] = useState<any>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [allPermissions, setAllPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    Promise.all([
      get("/api/admin/users"),
      get(`/api/admin/users/${userId}/permissions`),
    ]).then(([usersRes, permRes]) => {
      const u = usersRes.users.find((u: any) => u.id === userId);
      setUser(u);
      setPermissions(permRes.permissions);
      setAllPermissions(permRes.allPermissions);
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
  }, [userId]);

  const togglePermission = (perm: string) => {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  };

  const selectAllInGroup = (group: typeof PERMISSION_GROUPS[0]) => {
    const groupPerms = group.permissions.map((p) => p.key);
    const allSelected = groupPerms.every((p) => permissions.includes(p));
    if (allSelected) {
      setPermissions((prev) => prev.filter((p) => !groupPerms.includes(p)));
    } else {
      setPermissions((prev) => [...new Set([...prev, ...groupPerms])]);
    }
  };

  const savePermissions = async () => {
    setSaving(true);
    try {
      await put(`/api/admin/users/${userId}`, { permissions });
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
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/admin/users"; }}><ArrowLeft size={14} /></Btn>
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">{user.email}</h1>
          <p className="text-[9px] text-muted font-mono mt-0.5 uppercase tracking-wider">
            {user.isAdmin ? "Admin — has all permissions" : "User — permissions managed below"}
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
            <Btn variant="primary" loading={saving} onClick={savePermissions}><Save size={13} /> Save</Btn>
          </div>
          <div className="space-y-6">
            {PERMISSION_GROUPS.map((group) => {
              const allSelected = group.permissions.every((p) => permissions.includes(p.key));
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
                      const checked = permissions.includes(perm.key);
                      return (
                        <label
                          key={perm.key}
                          className={`flex items-center gap-2.5 px-3 py-2 border-2 border-fg cursor-pointer transition-all ${
                            checked
                              ? "bg-accent/20 shadow-neo-sm"
                              : "bg-bg-raised hover:bg-alt shadow-neo-sm hover:-translate-x-px hover:-translate-y-px hover:shadow-neo"
                          } active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none`}
                        >
                          <input type="checkbox" checked={checked} onChange={() => togglePermission(perm.key)} className="hidden" />
                          <span className={`w-4 h-4 border-2 border-fg flex-shrink-0 flex items-center justify-center ${checked ? "bg-accent" : "bg-bg-raised"}`}>
                            {checked && <span className="block w-2 h-2 bg-fg" />}
                          </span>
                          <div>
                            <span className="font-mono text-[9px] text-fg font-bold uppercase">{perm.key}</span>
                            <span className="block font-mono text-[8px] text-muted">{perm.label}</span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Reset Password */}
      <Card className="p-5">
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">Reset Password</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 8 chars)" />
          </div>
          <Btn variant="default" loading={savingPassword} onClick={resetPassword}>Update Password</Btn>
        </div>
      </Card>
    </div>
  );
}
