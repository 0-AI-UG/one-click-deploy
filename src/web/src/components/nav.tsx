import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Cpu,
  HardDrive,
  Home,
  Layers,
  LogOut,
  Menu,
  Server,
  Terminal,
  TerminalSquare,
  User,
  Users,
} from "lucide-react";
import { useAuth, logout } from "../stores/auth.ts";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "./mobile-action-sheet.tsx";
import { SkillInstallMenu } from "./skill-install-menu.tsx";

const navItems = [
  { hash: "#/", label: "Dashboard", icon: Server, match: /^#\/?$/ },
  { hash: "#/environments", label: "Env", icon: Layers, match: /^#\/environments/ },
  { hash: "#/resources", label: "Resources", icon: HardDrive, match: /^#\/resources/ },
  { hash: "#/engine", label: "Engine", icon: Cpu, match: /^#\/engine/ },
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

function MobileCliCopyButton() {
  const [copied, setCopied] = useState(false);
  const installCmd = `curl -fsSL ${window.location.origin}/cli/install.sh | sh`;

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(installCmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="flex min-h-12 w-full items-center gap-3 border-2 border-fg bg-bg-raised px-4 py-3 font-mono text-[11px] font-bold uppercase shadow-neo-sm"
      title={installCmd}
    >
      {copied ? <Check size={18} className="text-green-600" /> : <TerminalSquare size={18} />}
      {copied ? "Copied install command" : "Copy CLI install command"}
    </button>
  );
}

function MobileMenu({ hash }: { hash: string }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        target instanceof Element &&
        target.closest("[data-skill-install-menu]")
      ) {
        return;
      }
      if (ref.current && !ref.current.contains(target)) setOpen(false);
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
          {navItems.map((item) => {
            const active = item.match.test(hash);
            const Icon = item.icon;
            return (
              <a
                key={item.hash}
                href={item.hash}
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
          {user?.isAdmin && (
            <a
              href="#/admin"
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider transition-all ${
                hash.startsWith("#/admin") ? "bg-fg text-accent" : "text-fg/70 hover:bg-fg/5"
              }`}
            >
              <Users size={13} />
              Admin
            </a>
          )}
          <div className="border-t border-fg/10 py-1">
            <div className="flex items-center">
              <CliCopyButton />
              <SkillInstallMenu />
            </div>
          </div>
          <div className="border-t border-fg/10 px-3 py-2 font-mono text-[10px] text-fg/70 flex items-center justify-between">
            <a
              href="#/account"
              onClick={() => setOpen(false)}
              className="truncate hover:text-fg transition-all"
            >
              {user?.username}
              {user?.isAdmin && (
                <span className="ml-1.5 font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5 bg-fg text-accent">
                  admin
                </span>
              )}
            </a>
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
        <a href="#/" className="flex items-center gap-2 text-fg font-mono font-bold text-sm tracking-wider shrink-0">
          <Terminal size={18} />
          <span>OCD</span>
          <span className="font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5">v0.4</span>
        </a>
        <div className="h-5 w-0.5 bg-fg/30" />
        <div className="flex items-center gap-1">
          {navItems.map((item) => {
            const active = item.match.test(hash);
            const Icon = item.icon;
            return (
              <a
                key={item.hash}
                href={item.hash}
                className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                  active ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
                }`}
              >
                <Icon size={13} />
                {item.label}
              </a>
            );
          })}
          {user?.isAdmin && (
            <a
              href="#/admin"
              className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                hash.startsWith("#/admin") ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
              }`}
            >
              <Users size={13} />
              Admin
            </a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center">
          <CliCopyButton />
          <SkillInstallMenu />
        </div>
        <div className="h-5 w-0.5 bg-fg/30" />
        <a
          href="#/account"
          className={`font-mono text-[10px] whitespace-nowrap px-2 py-1 transition-all ${
            hash.startsWith("#/account") ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
          }`}
        >
          {user?.username}
          {user?.isAdmin && (
            <span className="ml-1.5 font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5 bg-fg text-accent">
              admin
            </span>
          )}
        </a>
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
      <a href="#/" className="flex items-center gap-2 text-fg font-mono font-bold text-sm tracking-wider shrink-0">
        <Terminal size={18} />
        <span>OCD</span>
        <span className="font-mono text-[9px] font-bold uppercase border border-fg px-1 py-0.5">v0.4</span>
      </a>
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

function MobileNav({ hash }: { hash: string }) {
  const { user } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [hash]);

  const primaryItems = [
    { hash: "#/", label: "Home", icon: Home, active: /^#\/?$/.test(hash) || /^#\/(apps|stacks|services)\//.test(hash) },
    { hash: "#/environments", label: "Envs", icon: Layers, active: hash.startsWith("#/environments") },
    { hash: "#/resources", label: "Resources", icon: HardDrive, active: hash.startsWith("#/resources") },
  ];

  return (
    <>
      <header className="sticky top-0 z-50 border-b-2 border-fg bg-accent pt-[env(safe-area-inset-top)]">
        <div className="flex h-[52px] items-center justify-between px-4">
          <a href="#/" className="flex h-11 items-center gap-2 font-mono font-bold tracking-wider text-fg" aria-label="OCD dashboard">
            <span className="grid h-8 w-8 place-items-center border-2 border-fg bg-fg text-accent"><Terminal size={17} /></span>
            <span>OCD</span>
          </a>
          <button onClick={() => setMoreOpen(true)} className="flex h-11 max-w-[55%] items-center gap-2 rounded-full px-2 font-mono text-[10px] font-bold text-fg" aria-label="Open account and navigation menu">
            <span className="truncate">{user?.username}</span>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-fg bg-bg-raised"><User size={15} /></span>
          </button>
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-fg bg-bg-raised pb-[env(safe-area-inset-bottom)]" aria-label="Primary navigation">
        <div className="grid h-[62px] grid-cols-4">
          {primaryItems.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.hash} href={item.hash} className={`flex min-w-0 flex-col items-center justify-center gap-1 font-mono text-[9px] font-bold uppercase ${item.active ? "bg-accent text-fg" : "text-muted"}`} aria-current={item.active ? "page" : undefined}>
                <Icon size={20} strokeWidth={item.active ? 2.5 : 2} />
                <span>{item.label}</span>
              </a>
            );
          })}
          <button onClick={() => setMoreOpen(true)} className={`flex flex-col items-center justify-center gap-1 font-mono text-[9px] font-bold uppercase ${moreOpen || hash.startsWith("#/engine") || hash.startsWith("#/admin") || hash.startsWith("#/account") ? "bg-accent text-fg" : "text-muted"}`}>
            <Menu size={20} /><span>More</span>
          </button>
        </div>
      </nav>

      <MobileActionSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="OCD Menu" subtitle={user?.username}>
        <MobileSheetAction icon={<Cpu size={19} />} label="Engine" detail="Operations and recovery" onClick={() => { window.location.hash = "#/engine"; }} />
        {user?.isAdmin && <MobileSheetAction icon={<Users size={19} />} label="Admin" detail="Users and permissions" onClick={() => { window.location.hash = "#/admin"; }} />}
        <MobileSheetAction icon={<User size={19} />} label="Account" detail="Security and profile" onClick={() => { window.location.hash = "#/account"; }} />
        <MobileCliCopyButton />
        <div className="border-2 border-fg bg-bg-raised px-3 py-2"><SkillInstallMenu /></div>
        <MobileSheetAction icon={<LogOut size={19} />} label="Log out" danger onClick={() => { logout(); window.location.hash = "#/login"; }} />
      </MobileActionSheet>
    </>
  );
}

export function Nav() {
  const { user } = useAuth();
  const hash = window.location.hash || "#/";
  const isMobile = useMobileLayout();
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (isMobile) return;
    const check = () => {
      const ghost = ghostRef.current;
      const container = containerRef.current;
      if (ghost && container) setCollapsed(ghost.offsetWidth > container.clientWidth + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMobile, user?.id, user?.isAdmin]);

  if (isMobile) return <MobileNav hash={hash} />;

  return (
    <nav className="sticky top-0 z-50 bg-accent border-b-2 border-fg">
      <div className="max-w-5xl mx-auto px-4 relative">
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
