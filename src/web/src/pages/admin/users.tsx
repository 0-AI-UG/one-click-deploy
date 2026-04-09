import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, Btn, Table, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { Users, Plus, Trash2, Shield, ShieldCheck, Key, ShieldAlert } from "lucide-react";

type User = {
  id: string; username: string; isAdmin: boolean; totpEnabled: boolean;
  webauthnEnabled: boolean; permissions: string[]; createdAt: string;
};

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [require2fa, setRequire2fa] = useState(true);
  const [savingRequire2fa, setSavingRequire2fa] = useState(false);

  const load = async () => {
    try {
      const res = await get("/api/admin/users");
      setUsers(res.users);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    get("/api/settings")
      .then((s) => setRequire2fa(s.require_2fa !== false))
      .catch(() => {});
  }, []);

  const toggleRequire2fa = async (next: boolean) => {
    setSavingRequire2fa(true);
    setRequire2fa(next);
    try {
      await put("/api/settings", { require_2fa: next });
      showToast(next ? "2FA now required for new users" : "2FA no longer required", "success");
    } catch (err: any) {
      setRequire2fa(!next);
      showToast(err.message, "error");
    } finally {
      setSavingRequire2fa(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) return showToast("Username and password required", "error");
    setCreating(true);
    try {
      await post("/api/admin/users", form);
      showToast("User created", "success");
      setShowCreate(false);
      setForm({ username: "", password: "" });
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user: User) => {
    if (!await confirm("Delete User", `Delete user "${user.username}"? This cannot be undone.`, true)) return;
    try {
      await del(`/api/admin/users/${user.id}`);
      showToast("User deleted", "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Users size={18} className="text-fg" />
          <h1 className="font-mono font-bold text-sm text-fg uppercase">User Management</h1>
          <span className="font-mono text-[9px] text-muted">{users.length} user{users.length !== 1 ? "s" : ""}</span>
        </div>
        <Btn variant="primary" onClick={() => setShowCreate(!showCreate)}>
          <Plus size={13} /> Create User
        </Btn>
      </div>

      {showCreate && (
        <Card className="p-4 mb-4 animate-slide-up">
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider mb-3">New User</h3>
          <form onSubmit={handleCreate} className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Username</label>
              <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username" required />
            </div>
            <div className="flex-1">
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Password</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 8 characters" required />
            </div>
            <Btn type="submit" variant="primary" loading={creating}>
              Create
            </Btn>
          </form>
        </Card>
      )}

      <Card className="p-4 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <span title="Global authentication policy"><ShieldAlert size={14} className="text-fg mt-0.5" /></span>
            <div>
              <div
                className="font-mono text-[11px] text-fg font-bold"
                title="When on, every new non-admin user must set up an authenticator app the first time they log in. Admins always require 2FA regardless of this setting."
              >
                Require 2FA for new users
              </div>
              <div
                className="font-mono text-[10px] text-muted mt-0.5"
                title="Existing users who already logged in without 2FA are not affected by this toggle. They keep their current login flow until they enable 2FA themselves."
              >
                Existing users without 2FA are not affected.
              </div>
            </div>
          </div>
          <label
            className="inline-flex items-center cursor-pointer"
            title={require2fa ? "Click to allow new non-admin users to log in without 2FA" : "Click to force new non-admin users to set up 2FA on first login"}
          >
            <input
              type="checkbox"
              checked={require2fa}
              disabled={savingRequire2fa}
              onChange={(e) => toggleRequire2fa(e.target.checked)}
            />
          </label>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <Table headers={["Username", "Role", "2FA", "Permissions", "Created", ""]}>
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-alt/50 cursor-pointer" onClick={() => { window.location.hash = `#/admin/users/${u.id}`; }}>
              <td className="py-2.5 px-3">
                <span className="text-fg font-bold">{u.username}</span>
              </td>
              <td className="py-2.5 px-3">
                {u.isAdmin ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase bg-accent-amber border-2 border-fg px-1.5 py-0.5 text-fg shadow-neo-sm">
                    <ShieldCheck size={10} /> Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase bg-alt border-2 border-fg px-1.5 py-0.5 text-fg-dim shadow-neo-sm">
                    <Shield size={10} /> User
                  </span>
                )}
              </td>
              <td className="py-2.5 px-3">
                {u.totpEnabled && u.webauthnEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">Both</span>
                ) : u.totpEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">TOTP</span>
                ) : u.webauthnEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">Passkey</span>
                ) : (
                  <span className="text-muted text-[9px] font-mono uppercase">None</span>
                )}
              </td>
              <td className="py-2.5 px-3">
                <span className="inline-flex items-center gap-1 text-[9px] font-mono text-fg-dim">
                  <Key size={10} /> {u.isAdmin ? "All" : `${u.permissions.length}`}
                </span>
              </td>
              <td className="py-2.5 px-3 text-muted font-mono text-[10px]">{new Date(u.createdAt).toLocaleDateString()}</td>
              <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                {!u.isAdmin && (
                  <Btn size="xs" variant="danger" onClick={() => handleDelete(u)}>
                    <Trash2 size={11} />
                  </Btn>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

    </div>
  );
}
