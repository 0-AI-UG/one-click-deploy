import { useState, useRef, useEffect, type ReactNode } from "react";
import { useAuth, logout, orgPath } from "../stores/auth.ts";
import { OrgSwitcher } from "./org-switcher.tsx";
import { Server, Rocket, HardDrive, User, LogOut, Terminal, Layers, TerminalSquare, Check, Cpu, Menu } from "lucide-react";

const navItemDefs = [
  { path: "/", label: "Dashboard", icon: Server, matchSuffix: /\/$/ },
  { path: "/deploy", label: "Deploy", icon: Rocket, matchSuffix: /\/deploy/ },
  { path: "/environments", label: "Env", icon: Layers, matchSuffix: /\/environments/ },
  { path: "/resources", label: "Resources", icon: HardDrive, matchSuffix: /\/resources/ },
  { path: "/engine", label: "Engine", icon: Cpu, matchSuffix: /\/engine/ },
  { path: "/account", label: "Account", icon: User, matchSuffix: /\/account/ },
];

function CliCopyButton() {
  const [copied, setCopied] = useState(false);
  const installCmd = `curl -fsSL ${window.location.origin}/cli/install.sh | sh`;

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(installCmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 hover:text-fg hover:bg-fg/10 transition-all"
      title={installCmd}
    >
      {copied ? <Check size={13} className="text-green-600" /> : <TerminalSquare size={13} />}
      {copied ? "Copied" : "CLI"}
    </button>
  );
}

function MobileMenu({ hash }: { hash: string }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 text-fg/70 hover:text-fg hover:bg-fg/10 transition-all"
        aria-label="Menu"
      >
        <Menu size={18} />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-56 bg-white border-2 border-fg shadow-neo z-50">
          {navItemDefs.map((item) => {
            const href = orgPath(item.path);
            const active = item.matchSuffix.test(hash);
            const Icon = item.icon;
            return (
              <a
                key={item.path}
                href={href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider transition-all ${
                  active ? "bg-fg text-accent" : "text-fg/70 hover:bg-fg/5"
                }`}
              >
                <Icon size={13} />
                {item.label}
              </a>
            );
          })}
          <div className="border-t border-fg/10 py-1">
            <CliCopyButton />
          </div>
          <div className="border-t border-fg/10 px-3 py-2 font-mono text-[10px] text-fg/70 flex items-center justify-between">
            <span className="truncate">{user?.username}</span>
            <button
              onClick={() => { logout(); window.location.hash = "#/login"; }}
              className="p-1 text-fg/60 hover:text-accent-red transition-all"
              title="Logout"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DesktopNav({ user, hash }: { user: ReturnType<typeof useAuth>["user"]; hash: string }) {
  return (
    <>
      <div className="flex items-center gap-5 min-w-0">
        <a href={orgPath("/")} className="flex items-center gap-2 text-fg font-mono font-bold text-sm tracking-wider shrink-0">
          <Terminal size={18} />
          <span>OCD</span>
          <span className="font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5">v0.4</span>
        </a>
        <div className="h-5 w-0.5 bg-fg/30" />
        <OrgSwitcher />
        <div className="h-5 w-0.5 bg-fg/30" />
        <div className="flex items-center gap-1">
          {navItemDefs.map((item) => {
            const href = orgPath(item.path);
            const active = item.matchSuffix.test(hash);
            const Icon = item.icon;
            return (
              <a
                key={item.path}
                href={href}
                className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                  active ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
                }`}
              >
                <Icon size={13} />
                {item.label}
              </a>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <CliCopyButton />
        <div className="h-5 w-0.5 bg-fg/30" />
        <span className="font-mono text-[10px] text-fg/70 whitespace-nowrap">
          {user?.username}
        </span>
        <button
          onClick={() => { logout(); window.location.hash = "#/login"; }}
          className="p-1.5 text-fg/60 hover:text-accent-red transition-all"
          title="Logout"
        >
          <LogOut size={14} />
        </button>
      </div>
    </>
  );
}

function CompactNav({ hash }: { hash: string }) {
  return (
    <>
      <div className="flex items-center gap-3 min-w-0">
        <a href={orgPath("/")} className="flex items-center gap-2 text-fg font-mono font-bold text-sm tracking-wider shrink-0">
          <Terminal size={18} />
          <span>OCD</span>
          <span className="font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5">v0.4</span>
        </a>
        <OrgSwitcher />
      </div>
      <MobileMenu hash={hash} />
    </>
  );
}

function Row({ innerRef, children }: { innerRef?: React.Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div ref={innerRef} className="h-12 flex items-center justify-between gap-2">
      {children}
    </div>
  );
}

export function Nav() {
  const { user } = useAuth();
  const hash = window.location.hash || "#/";
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const check = () => {
      const ghost = ghostRef.current;
      const container = containerRef.current;
      if (!ghost || !container) return;
      setCollapsed(ghost.offsetWidth > container.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [user?.id]);

  return (
    <nav className="sticky top-0 z-50 bg-accent border-b-2 border-fg">
      <div className="max-w-7xl mx-auto px-4 relative">
        <Row innerRef={containerRef}>
          {collapsed ? <CompactNav hash={hash} /> : <DesktopNav user={user} hash={hash} />}
        </Row>
        <div
          ref={ghostRef}
          aria-hidden
          className="absolute top-0 left-4 invisible pointer-events-none"
          style={{ width: "max-content" }}
        >
          <div className="h-12 flex items-center gap-2">
            <DesktopNav user={user} hash={hash} />
          </div>
        </div>
      </div>
    </nav>
  );
}
