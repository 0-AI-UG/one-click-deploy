import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, Btn, Table, Spinner, showToast, confirm } from "../../components/ui.tsx";
import { Users, Plus, Trash2, Shield, ShieldCheck, Key, Lock } from "lucide-react";

type User = {
  id: string; email: string; isAdmin: boolean; totpEnabled: boolean;
  permissions: string[]; createdAt: string;
};

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

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

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.email || !form.password) return showToast("Email and password required", "error");
    setCreating(true);
    try {
      await post("/api/admin/users", form);
      showToast("User created", "success");
      setShowCreate(false);
      setForm({ email: "", password: "" });
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const changeMyPassword = async () => {
    if (!currentPassword) return showToast("Current password is required", "error");
    if (!newPassword || newPassword.length < 8) return showToast("New password must be at least 8 characters", "error");
    if (!totpCode) return showToast("2FA code is required", "error");
    setSavingPassword(true);
    try {
      await put("/api/me", { currentPassword, newPassword, totpCode });
      showToast("Password changed", "success");
      setCurrentPassword("");
      setNewPassword("");
      setTotpCode("");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPassword(false);
    }
  };

  const handleDelete = async (user: User) => {
    if (!await confirm("Delete User", `Delete user "${user.email}"? This cannot be undone.`, true)) return;
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
              <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@example.com" required />
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

      <Card className="overflow-hidden">
        <Table headers={["Email", "Role", "2FA", "Permissions", "Created", ""]}>
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-alt/50 cursor-pointer" onClick={() => { window.location.hash = `#/admin/users/${u.id}`; }}>
              <td className="py-2.5 px-3">
                <span className="text-fg font-bold">{u.email}</span>
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
                {u.totpEnabled ? (
                  <span className="text-fg text-[9px] font-mono font-bold uppercase">Enabled</span>
                ) : (
                  <span className="text-muted text-[9px] font-mono uppercase">Disabled</span>
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

      {/* Change My Password */}
      <Card className="p-5 mt-4">
        <div className="flex items-center gap-2 mb-3">
          <Lock size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Change My Password</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">Current Password</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 characters" />
          </div>
          <div>
            <label className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg block mb-1">2FA Code</label>
            <input type="text" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} placeholder="6-digit code" maxLength={6} inputMode="numeric" />
          </div>
        </div>
        <div className="mt-3">
          <Btn variant="default" loading={savingPassword} onClick={changeMyPassword}>Change Password</Btn>
        </div>
      </Card>
    </div>
  );
}
