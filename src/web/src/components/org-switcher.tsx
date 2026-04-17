import { useState, useRef, useEffect } from "react";
import { useAuth, setCurrentOrg, orgPath } from "../stores/auth.ts";
import { Building2, ChevronDown, Settings, Plus } from "lucide-react";

export function OrgSwitcher() {
  const { orgs, currentOrgId } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentOrg = orgs.find((o) => o.id === currentOrgId);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSwitch = (orgId: string) => {
    setCurrentOrg(orgId);
    setOpen(false);
    window.location.hash = `#/orgs/${orgId}`;
    window.location.reload();
  };

  if (orgs.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 hover:text-fg hover:bg-fg/10 transition-all"
      >
        <Building2 size={13} />
        <span className="max-w-[100px] truncate">{currentOrg?.name || "Select org"}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border-2 border-fg shadow-neo z-50">
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => handleSwitch(org.id)}
              className={`w-full text-left px-3 py-2 font-mono text-xs hover:bg-fg/5 transition-all flex items-center justify-between ${
                org.id === currentOrgId ? "bg-accent/30 font-bold" : ""
              }`}
            >
              <span className="truncate">{org.name}</span>
              <span className="text-[9px] uppercase text-fg/40">{org.role}</span>
            </button>
          ))}
          <div className="border-t border-fg/10">
            <a
              href={orgPath("/org-settings")}
              onClick={() => setOpen(false)}
              className="w-full text-left px-3 py-2 font-mono text-xs hover:bg-fg/5 transition-all flex items-center gap-2 text-fg/60"
            >
              <Settings size={11} /> Org Settings
            </a>
            <a
              href="#/create-org"
              onClick={() => setOpen(false)}
              className="w-full text-left px-3 py-2 font-mono text-xs hover:bg-fg/5 transition-all flex items-center gap-2 text-fg/60"
            >
              <Plus size={11} /> New Organization
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
