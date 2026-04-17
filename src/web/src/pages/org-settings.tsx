import { useState, useEffect, useCallback } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { get, put, post, del } from "../api/client.ts";
import { useAuth, setOrgs, orgPath } from "../stores/auth.ts";
import { Card, Btn, Spinner, Checkbox, showToast, confirm } from "../components/ui.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { BillingModal } from "../components/billing-modal.tsx";
import { getStripePromise, stripeAppearance } from "../lib/stripe.ts";
import { Building2, Users, Shield, Key, UserMinus, Mail, X, ChevronDown, ChevronRight, Pencil, CreditCard, Box, Calendar, Save, FileText, Download } from "lucide-react";
import { errMsg } from "../lib/errors.ts";

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

  const currentMember = members.find((m) => m.user_id === currentUserId);
  const isOwner = currentMember?.role === "owner";

  const load = async () => {
    try {
      const m = await get(`/api/orgs/${orgId}/members`);
      setMembers(m);
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [orgId]);

  const loadPermissions = async (userId: string) => {
    try {
      const perms = await get(`/api/orgs/${orgId}/members/${userId}/permissions`);
      setMemberPermissions((prev) => ({ ...prev, [userId]: perms }));
    } catch (err) {
      showToast(errMsg(err), "error");
    }
  };

  const toggleMember = (userId: string, role: string) => {
    if (role === "owner") return;
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
    } catch (err) {
      showToast(errMsg(err), "error");
    } finally {
      setSavingPerms(null);
    }
  };

  const handleRemove = async (userId: string, username: string) => {
    const ok = await confirm("Remove member", `Remove ${username} from this organization?`, true);
    if (!ok) return;
    try {
      await del(`/api/orgs/${orgId}/members/${userId}`);
      showToast("Member removed");
      load();
    } catch (err) {
      showToast(errMsg(err), "error");
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
          const canExpand = m.role === "member" && isOwner;

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
                  {isOwner && m.role !== "owner" && m.user_id !== currentUserId && (
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
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const inv = await get(`/api/orgs/${orgId}/invitations`);
      setInvitations(inv);
    } catch (err) {
      showToast(errMsg(err), "error");
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
      await post(`/api/orgs/${orgId}/invitations`, { email: inviteEmail });
      showToast("Invitation sent");
      setInviteEmail("");
      load();
    } catch (err) {
      showToast(errMsg(err), "error");
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
    } catch (err) {
      showToast(errMsg(err), "error");
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

type ServerTypeInfo = { name: string; description: string; cores: number; memory: number; disk: number; locations: string[] };

function CredentialsSection({ orgId }: { orgId: string }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [token, setToken] = useState("");
  const [dnsZoneId, setDnsZoneId] = useState("");
  const [serverType, setServerType] = useState("");
  const [location, setLocation] = useState("");

  const [serverTypes, setServerTypes] = useState<ServerTypeInfo[]>([]);
  const [fetchingTypes, setFetchingTypes] = useState(false);

  const load = () => {
    get(`/api/orgs/${orgId}/settings`)
      .then((s) => {
        setSettings(s);
        setDnsZoneId(s.dns_zone_id || "");
        setServerType(s.default_server_type || "");
        setLocation(s.default_location || "");
      })
      .catch((err: unknown) => showToast(errMsg(err), "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [orgId]);

  // Fetch server types on mount using stored token (no body token needed)
  useEffect(() => {
    post(`/api/orgs/${orgId}/server-types`, {})
      .then((res) => {
        if (res.server_types?.length) setServerTypes(res.server_types);
      })
      .catch(() => {});
  }, [orgId]);

  // Re-fetch when a new token is entered
  useEffect(() => {
    if (token.length < 10) return;
    const timer = setTimeout(async () => {
      setFetchingTypes(true);
      try {
        const res = await post(`/api/orgs/${orgId}/server-types`, { provider_token: token });
        if (res.server_types?.length) {
          setServerTypes(res.server_types);
          if (!serverType) setServerType(res.server_types[0].name);
        }
      } catch {} finally { setFetchingTypes(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [token]);

  // Reset location when server type changes and current location is invalid
  const selectedType = serverTypes.find((t) => t.name === serverType);
  const validLocations = selectedType?.locations || [];
  useEffect(() => {
    if (validLocations.length > 0 && !validLocations.includes(location)) {
      setLocation(validLocations[0]);
    }
  }, [serverType, validLocations.length]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {
        dns_zone_id: dnsZoneId,
        default_server_type: serverType,
        default_location: location,
      };
      if (token) body.provider_token = token;
      await put(`/api/orgs/${orgId}/settings`, body);
      showToast("Credentials updated");
      setToken("");
      load();
    } catch (err) {
      showToast(errMsg(err) || "Failed to save", "error");
    } finally { setSaving(false); }
  };

  if (loading) return <Card className="p-5"><div className="flex justify-center"><Spinner /></div></Card>;

  const typeOptions = serverTypes.map((t) => ({
    value: t.name,
    label: `${t.name} — ${t.cores} vCPU, ${t.memory}GB RAM, ${t.disk}GB`,
  }));
  const locationOptions = validLocations.map((l) => ({ value: l, label: l }));

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Key size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Provider Credentials</h2>
      </div>

      <div className="space-y-3">
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Hetzner API Token</label>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={settings.provider_token_masked || "Enter Hetzner API token"} />
          {fetchingTypes && <div className="flex items-center gap-2 mt-1.5 font-mono text-[9px] text-fg-dim"><Spinner /> Verifying token...</div>}
        </div>
        <div>
          <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">DNS Zone ID <span className="text-fg/40">(optional)</span></label>
          <input type="text" value={dnsZoneId} onChange={(e) => setDnsZoneId(e.target.value)} placeholder="Hetzner DNS zone ID" />
        </div>
        {typeOptions.length > 0 && (
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Server Type</label>
            <NeoSelect value={serverType} options={typeOptions} onChange={setServerType} />
          </div>
        )}
        {locationOptions.length > 0 && (
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Default Location</label>
            <NeoSelect value={location} options={locationOptions} onChange={setLocation} />
          </div>
        )}
        <Btn variant="primary" loading={saving} onClick={handleSave}>
          <Save size={11} /> Save
        </Btn>
      </div>
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
    } catch (err) {
      showToast(errMsg(err), "error");
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
    } catch (err) {
      showToast(errMsg(err), "error");
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
      window.location.hash = orgs.length > 0 ? orgPath("/") : "#/create-org";
      window.location.reload();
    } catch (err) {
      showToast(errMsg(err), "error");
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

type DefaultPaymentMethod = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

type BillingStatus = {
  required: boolean;
  status: string;
  seatCount: number;
  appCount: number;
  memberCount: number;
  pricePerSeat: number;
  currentPeriodEnd: string | null;
  stripePublishableKey: string | null;
  hasPaymentMethod: boolean;
  defaultPaymentMethod: DefaultPaymentMethod | null;
};

type Invoice = {
  id: string;
  number: string | null;
  amount: number;
  currency: string;
  status: string;
  created: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function BillingSection() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [updateCardOpen, setUpdateCardOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const loadBilling = useCallback(() => {
    get("/api/billing").then(setBilling).catch(() => showToast("Failed to load billing", "error"));
  }, []);

  const loadInvoices = useCallback(() => {
    get("/api/billing/invoices").then((res: { invoices: Invoice[] }) => setInvoices(res.invoices || [])).catch(() => {});
  }, []);

  useEffect(() => { loadBilling(); }, [loadBilling]);
  useEffect(() => {
    if (billing?.status === "active" || billing?.status === "past_due") loadInvoices();
  }, [billing?.status, loadInvoices]);

  if (!billing) {
    return <Card className="p-5"><div className="flex justify-center"><Spinner /></div></Card>;
  }

  const total = billing.seatCount * billing.pricePerSeat;

  const handleCancel = async () => {
    const yes = await confirm(
      "Cancel subscription",
      "Your subscription will remain active until the end of the current billing period. After that, deploying new apps will require resubscribing.",
      true,
    );
    if (!yes) return;
    setCanceling(true);
    try {
      await post("/api/billing/cancel");
      showToast("Subscription will cancel at period end", "success");
      loadBilling();
    } catch (err) {
      showToast(errMsg(err) || "Failed to cancel", "error");
    } finally {
      setCanceling(false);
    }
  };

  const subscribeNeeded = billing.appCount >= 1 && billing.status !== "active";

  return (
    <Card className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <CreditCard size={14} className="text-fg" />
        <h2 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Billing</h2>
      </div>

      {/* Pricing overview */}
      <div className="grid grid-cols-3 gap-4 text-center border-2 border-fg/10 p-4">
        <div>
          <div className="flex items-center justify-center gap-1.5 text-fg-dim mb-1">
            <Box size={12} />
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider">Apps</span>
          </div>
          <span className="font-mono text-xl font-bold">{billing.appCount}</span>
        </div>
        <div>
          <div className="flex items-center justify-center gap-1.5 text-fg-dim mb-1">
            <Users size={12} />
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider">Seats</span>
          </div>
          <span className="font-mono text-xl font-bold">{billing.seatCount}</span>
        </div>
        <div>
          <div className="flex items-center justify-center gap-1.5 text-fg-dim mb-1">
            <CreditCard size={12} />
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider">Monthly</span>
          </div>
          <span className="font-mono text-xl font-bold">
            {billing.appCount >= 1 || billing.status === "active" ? `€${total}` : "Free"}
          </span>
        </div>
      </div>

      {/* Free tier — no apps deployed yet */}
      {billing.appCount === 0 && billing.status !== "active" && (
        <p className="font-mono text-xs text-fg-dim">
          Your organization is on the <span className="font-bold text-fg">free plan</span>. Your first app is free — billing starts when you deploy more than one app at <span className="font-bold text-fg">€{billing.pricePerSeat}/seat/month</span>.
        </p>
      )}

      {/* Active subscription */}
      {billing.status === "active" && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider">
                <span className="w-[7px] h-[7px] border-[1.5px] border-fg bg-accent" />
                Active
              </span>
              {billing.currentPeriodEnd && (
                <span className="flex items-center gap-1.5 font-mono text-[9px] text-fg-dim">
                  <Calendar size={11} />
                  Renews {new Date(billing.currentPeriodEnd).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="font-mono text-xs text-fg-dim mb-4">
              {billing.seatCount} seat{billing.seatCount !== 1 ? "s" : ""} × €{billing.pricePerSeat} = <span className="font-bold text-fg">€{total}/month</span>
            </p>
            <Btn variant="danger" onClick={handleCancel} loading={canceling}>
              Cancel subscription
            </Btn>
          </div>

          <PaymentMethodCard
            method={billing.defaultPaymentMethod}
            updateOpen={updateCardOpen}
            setUpdateOpen={setUpdateCardOpen}
            onUpdated={loadBilling}
          />

          <InvoicesList invoices={invoices} />
        </div>
      )}

      {/* Past due */}
      {billing.status === "past_due" && (
        <div className="border-2 border-accent-red p-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <span className="w-[7px] h-[7px] border-[1.5px] border-fg bg-accent-red" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-accent-red">Past Due</span>
          </div>
          <p className="font-mono text-xs text-fg-dim">
            Your last payment failed. Update your card to continue deploying.
          </p>
          <Btn variant="primary" onClick={() => setUpdateCardOpen(true)}>
            <CreditCard size={13} />
            Update card
          </Btn>
        </div>
      )}

      {/* Subscribe — requires payment */}
      {subscribeNeeded && (
        <div className="border-t-2 border-fg/10 pt-4">
          <p className="font-mono text-xs text-fg-dim mb-4">
            A subscription is required to deploy additional apps.
          </p>
          <p className="font-mono text-sm font-bold mb-4">
            {billing.seatCount} seat{billing.seatCount !== 1 ? "s" : ""} × €{billing.pricePerSeat} = €{total}/month
          </p>
          <Btn variant="primary" onClick={() => setModalOpen(true)}>
            <CreditCard size={13} />
            Activate now
          </Btn>
        </div>
      )}

      <BillingModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onActive={loadBilling}
        seatCount={billing.seatCount}
        pricePerSeat={billing.pricePerSeat}
      />
    </Card>
  );
}

function PaymentMethodCard({
  method,
  updateOpen,
  setUpdateOpen,
  onUpdated,
}: {
  method: DefaultPaymentMethod | null;
  updateOpen: boolean;
  setUpdateOpen: (v: boolean) => void;
  onUpdated: () => void;
}) {
  const [setupData, setSetupData] = useState<{ clientSecret: string; publishableKey: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!updateOpen) {
      setSetupData(null);
      return;
    }
    setLoading(true);
    post("/api/billing/payment-method/setup")
      .then((res) => setSetupData(res))
      .catch((err: unknown) => showToast(errMsg(err) || "Failed to start card update", "error"))
      .finally(() => setLoading(false));
  }, [updateOpen]);

  return (
    <div className="border-2 border-fg/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim">Payment method</span>
        {!updateOpen && (
          <button
            onClick={() => setUpdateOpen(true)}
            className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg hover:text-accent-blue"
          >
            {method ? "Update" : "Add card"}
          </button>
        )}
      </div>

      {!updateOpen && (
        method ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 border-2 border-fg font-mono text-[9px] font-bold uppercase tracking-wider bg-bg">
              {method.brand}
            </span>
            <span className="font-mono text-xs">···· {method.last4}</span>
            <span className="font-mono text-[10px] text-fg-dim">
              {String(method.expMonth).padStart(2, "0")}/{String(method.expYear).slice(-2)}
            </span>
          </div>
        ) : (
          <p className="font-mono text-[10px] text-fg-dim">No card on file.</p>
        )
      )}

      {updateOpen && (
        <div className="space-y-3 pt-1">
          {loading && <div className="flex justify-center py-4"><Spinner /></div>}
          {setupData && !loading && (
            <Elements
              stripe={getStripePromise(setupData.publishableKey)}
              options={{ clientSecret: setupData.clientSecret, appearance: stripeAppearance }}
            >
              <UpdateCardForm
                onDone={() => { setUpdateOpen(false); onUpdated(); }}
                onCancel={() => setUpdateOpen(false)}
              />
            </Elements>
          )}
        </div>
      )}
    </div>
  );
}

function UpdateCardForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmErr, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: {},
    });

    if (confirmErr) {
      setError(confirmErr.message || "Failed to save card");
      setSubmitting(false);
      return;
    }

    const paymentMethodId = typeof setupIntent?.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;

    if (!paymentMethodId) {
      setError("Card was confirmed but no payment method id was returned");
      setSubmitting(false);
      return;
    }

    try {
      await post("/api/billing/payment-method/attach", { paymentMethodId });
      showToast("Card updated", "success");
      onDone();
    } catch (err) {
      setError(errMsg(err) || "Failed to attach card");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <p className="font-mono text-[10px] text-accent-red">{error}</p>}
      <div className="flex gap-2">
        <Btn type="submit" variant="primary" loading={submitting} disabled={!stripe}>
          Save card
        </Btn>
        <Btn variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Btn>
      </div>
    </form>
  );
}

function InvoicesList({ invoices }: { invoices: Invoice[] }) {
  if (invoices.length === 0) return null;

  return (
    <div className="border-2 border-fg/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <FileText size={12} className="text-fg" />
        <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim">Invoices</span>
      </div>
      <div className="divide-y divide-fg/10">
        {invoices.map((inv) => (
          <div key={inv.id} className="flex items-center justify-between py-2 gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[11px] truncate">
                {inv.number || inv.id}
              </div>
              <div className="font-mono text-[9px] text-fg-dim">
                {new Date(inv.created).toLocaleDateString()}
              </div>
            </div>
            <div className="font-mono text-[11px] font-bold">{formatMoney(inv.amount, inv.currency)}</div>
            <span className={`font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-2 border-fg ${
              inv.status === "paid" ? "bg-accent" : inv.status === "open" ? "bg-accent-amber" : "bg-bg"
            }`}>
              {inv.status}
            </span>
            {inv.invoicePdf && (
              <a
                href={inv.invoicePdf}
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-dim hover:text-fg"
                title="Download PDF"
              >
                <Download size={12} />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
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
      <BillingSection />
    </div>
  );
}
