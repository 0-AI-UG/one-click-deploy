import { useState, useEffect } from "react";
import { get, put, post, del } from "../api/client.ts";
import { useAuth, setOrgs } from "../stores/auth.ts";
import { Card, Btn, Spinner, Checkbox, showToast, confirm } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Building2, Users, Shield, Key, UserMinus, Mail, X, ChevronDown, ChevronRight, Pencil } from "lucide-react";

type Member = { user_id: string; username: string; role: string };
type Invitation = { id: string; email: string; role: string; expires_at: string };
type OrgInfo = { id: string; name: string; slug: string };

const ALL_PERMISSIONS = [
  { group: "Apps", permissions: [
    { key: "apps.deploy", label: "Deploy" },
    { key: "apps.destroy", label: "Destroy" },
    { key: "apps.restart", label: "Restart" },
    { key: "apps.pause", label: "Pause" },
    { key: "apps.redeploy", label: "Redeploy" },
    { key: "apps.rollback", label: "Rollback" },
    { key: "apps.logs", label: "Logs" },
  ]},
  { group: "Servers", permissions: [
    { key: "servers.view", label: "View" },
    { key: "servers.delete", label: "Delete" },
  ]},
  { group: "Services", permissions: [
    { key: "services.deploy", label: "Deploy" },
    { key: "services.destroy", label: "Destroy" },
    { key: "services.manage", label: "Manage" },
    { key: "services.logs", label: "Logs" },
    { key: "services.link", label: "Link" },
  ]},
  { group: "Resources", permissions: [
    { key: "resources.view", label: "View" },
    { key: "resources.create", label: "Create" },
    { key: "resources.delete", label: "Delete" },
  ]},
  { group: "Scaling", permissions: [
    { key: "scaling.manage", label: "Manage" },
  ]},
  { group: "Volumes", permissions: [
    { key: "volumes.create", label: "Create" },
    { key: "volumes.manage", label: "Manage" },
  ]},
  { group: "Environments", permissions: [
    { key: "environments.manage", label: "Manage" },
  ]},
  { group: "Webhooks", permissions: [
    { key: "webhooks.manage", label: "Manage" },
  ]},
];

function MembersSection({ orgId, currentUserId }: { orgId: string; currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [memberPermissions, setMemberPermissions] = useState<Record<string, string[]>>({});
  const [savingPerms, setSavingPerms] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const currentMember = members.find((m) => m.user_id === currentUserId);
  const isOwner = currentMember?.role === "owner";
  const isAdmin = currentMember?.role === "owner" || currentMember?.role === "admin";

  const load = async () => {
    try {
      const m = await get(`/api/orgs/${orgId}/members`);
      setMembers(m);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [orgId]);

  const loadPermissions = async (userId: string) => {
    try {
      const perms = await get(`/api/orgs/${orgId}/members/${userId}/permissions`);
      setMemberPermissions((prev) => ({ ...prev, [userId]: perms }));
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const toggleMember = (userId: string, role: string) => {
    if (role === "owner" || role === "admin") return;
    if (expandedMember === userId) {
      setExpandedMember(null);
    } else {
      setExpandedMember(userId);
      if (!memberPermissions[userId]) loadPermissions(userId);
    }
  };

  const togglePermission = (userId: string, permKey: string) => {
    setMemberPermissions((prev) => {
      const current = prev[userId] || [];
      const next = current.includes(permKey)
        ? current.filter((p) => p !== permKey)
        : [...current, permKey];
      return { ...prev, [userId]: next };
    });
  };

  const savePermissions = async (userId: string) => {
    setSavingPerms(userId);
    try {
      await put(`/api/orgs/${orgId}/members/${userId}/permissions`, {
        permissions: memberPermissions[userId] || [],
      });
      showToast("Permissions updated");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPerms(null);
    }
  };

  const handleChangeRole = async (userId: string, newRole: string) => {
    setChangingRole(userId);
    try {
      await put(`/api/orgs/${orgId}/members/${userId}/role`, { role: newRole });
      showToast("Role updated");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setChangingRole(null);
    }
  };

  const handleRemove = async (userId: string, username: string) => {
    const ok = await confirm("Remove member", `Remove ${username} from this organization?`, true);
    if (!ok) return;
    try {
      await del(`/api/orgs/${orgId}/members/${userId}`);
      showToast("Member removed");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  if (loading) return <Card className="p-5"><div className="flex justify-center"><Spinner /></div></Card>;

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Users size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Members</h2>
      </div>

      <div className="space-y-0">
        {members.map((m) => {
          const expanded = expandedMember === m.user_id && m.role === "member";
          const canExpand = m.role === "member" && isAdmin;

          return (
            <div key={m.user_id} className="border-b border-fg/10 last:border-b-0">
              <div className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2">
                  {canExpand ? (
                    <button
                      onClick={() => toggleMember(m.user_id, m.role)}
                      className="text-fg/40 hover:text-fg transition-colors"
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  ) : (
                    <span className="w-3" />
                  )}
                  <span className="font-mono text-[11px] text-fg font-bold">{m.username}</span>
                  <span className="font-mono text-[9px] font-bold uppercase border-2 border-fg px-1.5 py-0.5 bg-alt">
                    {m.role}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {isOwner && m.role !== "owner" && (
                    <div className="w-24">
                      <NeoSelect
                        compact
                        value={m.role}
                        options={[
                          { value: "admin", label: "Admin" },
                          { value: "member", label: "Member" },
                        ]}
                        onChange={(v) => handleChangeRole(m.user_id, v)}
                      />
                    </div>
                  )}
                  {isAdmin && m.role !== "owner" && m.user_id !== currentUserId && (
                    <Btn size="xs" variant="danger" onClick={() => handleRemove(m.user_id, m.username)}>
                      <UserMinus size={11} />
                    </Btn>
                  )}
                </div>
              </div>

              {expanded && (
                <div className="pb-4 pl-5 animate-fade-in">
                  <div className="bg-alt border-2 border-fg p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Shield size={12} className="text-fg" />
                      <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">
                        Permissions for {m.username}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                      {ALL_PERMISSIONS.map((group) => (
                        <div key={group.group}>
                          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-muted block mb-1.5">
                            {group.group}
                          </span>
                          <div className="space-y-1">
                            {group.permissions.map((p) => (
                              <Checkbox
                                key={p.key}
                                checked={(memberPermissions[m.user_id] || []).includes(p.key)}
                                onChange={() => togglePermission(m.user_id, p.key)}
                                label={p.label}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex justify-end">
                      <Btn
                        size="xs"
                        variant="primary"
                        loading={savingPerms === m.user_id}
                        onClick={() => savePermissions(m.user_id)}
                      >
                        Save Permissions
                      </Btn>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function InviteSection({ orgId }: { orgId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const inv = await get(`/api/orgs/${orgId}/invitations`);
      setInvitations(inv);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [orgId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) return;
    setSending(true);
    try {
      await post(`/api/orgs/${orgId}/invitations`, { email: inviteEmail, role: inviteRole });
      showToast("Invitation sent");
      setInviteEmail("");
      setInviteRole("member");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSending(false);
    }
  };

  const handleRevoke = async (invId: string, email: string) => {
    const ok = await confirm("Revoke invitation", `Revoke the invitation for ${email}?`, true);
    if (!ok) return;
    try {
      await del(`/api/orgs/${orgId}/invitations/${invId}`);
      showToast("Invitation revoked");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Mail size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Invitations</h2>
      </div>

      <form onSubmit={handleInvite} className="flex gap-2 items-end">
        <div className="flex-1">
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Email</label>
          <input
            type="text"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </div>
        <div className="w-28">
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Role</label>
          <NeoSelect
            value={inviteRole}
            options={[
              { value: "member", label: "Member" },
              { value: "admin", label: "Admin" },
            ]}
            onChange={setInviteRole}
          />
        </div>
        <Btn type="submit" variant="primary" loading={sending}>Invite</Btn>
      </form>

      {loading ? (
        <div className="flex justify-center py-2"><Spinner /></div>
      ) : invitations.length > 0 && (
        <div className="border-t-2 border-fg pt-3">
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-muted block mb-2">Pending</span>
          <div className="space-y-1">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between bg-alt border-2 border-fg px-3 py-2">
                <div>
                  <span className="font-mono text-[10px] text-fg font-bold">{inv.email}</span>
                  <span className="font-mono text-[9px] text-muted ml-2">{inv.role}</span>
                  <span className="font-mono text-[9px] text-muted ml-2">
                    expires {new Date(inv.expires_at).toLocaleDateString()}
                  </span>
                </div>
                <button
                  onClick={() => handleRevoke(inv.id, inv.email)}
                  className="text-muted hover:text-accent-red transition-colors"
                  title="Revoke invitation"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function CredentialsSection({ orgId }: { orgId: string }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get(`/api/orgs/${orgId}/settings`)
      .then(setSettings)
      .catch((err: any) => showToast(err.message, "error"))
      .finally(() => setLoading(false));
  }, [orgId]);

  if (loading) return <Card className="p-5"><div className="flex justify-center"><Spinner /></div></Card>;

  const fields = [
    { label: "Token", value: settings.provider_token_masked },
    { label: "DNS Zone", value: settings.dns_zone_id },
    { label: "Default Server", value: settings.default_server_type },
    { label: "Default Location", value: settings.default_location },
  ];

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Key size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Provider Credentials</h2>
      </div>

      <div className="space-y-2">
        {fields.map((f) => (
          <div key={f.label} className="flex items-center justify-between py-1">
            <span className="font-mono text-[10px] text-muted">{f.label}</span>
            <span className="font-mono text-[10px] text-fg font-bold">{f.value || "Not set"}</span>
          </div>
        ))}
      </div>

      <Btn onClick={() => { window.location.hash = "#/org-onboarding"; }}>
        <Pencil size={11} /> Update Credentials
      </Btn>
    </Card>
  );
}

function OrgDetailsSection({ orgId }: { orgId: string }) {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const o = await get(`/api/orgs/${orgId}`);
      setOrg(o);
      setName(o.name);
      setSlug(o.slug);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [orgId]);

  const handleSave = async () => {
    if (!name || !slug) { showToast("Name and slug required", "error"); return; }
    setSaving(true);
    try {
      await put(`/api/orgs/${orgId}`, { name, slug });
      showToast("Organization updated");
      setEditing(false);
      load();
      // Refresh org list in nav
      const orgs = await get("/api/orgs");
      setOrgs(orgs);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm(
      "Delete organization",
      "This will permanently delete the organization and all associated data. This cannot be undone.",
      true,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await del(`/api/orgs/${orgId}`);
      showToast("Organization deleted");
      const orgs = await get("/api/orgs");
      setOrgs(orgs);
      window.location.hash = orgs.length > 0 ? "#/" : "#/create-org";
      window.location.reload();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <Card className="p-5"><div className="flex justify-center"><Spinner /></div></Card>;
  if (!org) return null;

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Building2 size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Organization</h2>
      </div>

      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Slug</label>
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} />
            <p className="font-mono text-[9px] text-muted mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>
          <div className="flex gap-2">
            <Btn variant="primary" loading={saving} onClick={handleSave}>Save</Btn>
            <Btn variant="ghost" onClick={() => { setEditing(false); setName(org.name); setSlug(org.slug); }}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-fg font-bold">{org.name}</span>
            <span className="font-mono text-[9px] text-muted ml-2">/{org.slug}</span>
          </div>
          <Btn size="xs" onClick={() => setEditing(true)}>
            <Pencil size={11} /> Edit
          </Btn>
        </div>
      )}

      <div className="border-t-2 border-fg pt-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="font-mono text-[11px] text-fg font-bold">Danger Zone</span>
            <p className="font-mono text-[9px] text-muted mt-0.5">Permanently delete this organization and all its data.</p>
          </div>
          <Btn size="xs" variant="danger" loading={deleting} onClick={handleDelete}>Delete Org</Btn>
        </div>
      </div>
    </Card>
  );
}

export function OrgSettingsPage() {
  const { currentOrgId, user } = useAuth();

  if (!currentOrgId) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-6">
        <p className="font-mono text-sm text-muted">No organization selected.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <Building2 size={18} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">Organization Settings</h1>
      </div>

      <OrgDetailsSection orgId={currentOrgId} />
      <MembersSection orgId={currentOrgId} currentUserId={user?.id || ""} />
      <InviteSection orgId={currentOrgId} />
      <CredentialsSection orgId={currentOrgId} />
    </div>
  );
}
