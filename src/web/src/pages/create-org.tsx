import { useState } from "react";
import { post } from "../api/client.ts";
import { setOrgs, setCurrentOrg } from "../stores/auth.ts";
import { showToast } from "../components/ui.tsx";
import { Spinner } from "../components/ui.tsx";
import { errMsg } from "../lib/errors.ts";

export function CreateOrgPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(false);

  const handleNameChange = (value: string) => {
    setName(value);
    // Auto-generate slug from name
    setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !slug) {
      showToast("Name and slug are required", "error");
      return;
    }
    setLoading(true);
    try {
      const org = await post("/api/orgs", { name, slug });
      setOrgs([{ ...org, role: "owner" }]);
      setCurrentOrg(org.id);
      window.location.hash = "#/org-onboarding";
    } catch (err) {
      showToast(errMsg(err) || "Failed to create organization", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm bg-white border-2 border-fg shadow-neo p-8">
        <h1 className="font-mono font-bold text-xl mb-2 text-fg">Create Organization</h1>
        <p className="font-mono text-xs text-fg/60 mb-6">Set up your team workspace to start deploying.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Organization Name</label>
            <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="My Team" required autoFocus />
          </div>
          <div>
            <label className="block font-mono text-xs font-bold uppercase tracking-wider text-fg mb-1">Slug</label>
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-team" required />
            <p className="font-mono text-[10px] text-fg/40 mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>
          <button type="submit" disabled={loading} className="w-full bg-accent text-fg border-2 border-fg font-mono font-bold text-xs uppercase tracking-wider px-4 py-2.5 shadow-neo hover:-translate-y-0.5 hover:shadow-neo-lg transition-all disabled:opacity-50">
            {loading ? <Spinner /> : "Create Organization"}
          </button>
        </form>
      </div>
    </div>
  );
}
