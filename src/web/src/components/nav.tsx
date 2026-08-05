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

function CliCopyButton({ mobile = false }: { mobile?: boolean }) {
  const [copied, setCopied] = useState(false);
  const installCmd = `curl -fsSL ${window.location.origin}/cli/install.sh | sh`;

  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(installCmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={mobile
        ? "flex min-h-12 w-full items-center gap-3 border-2 border-fg bg-bg-raised px-4 py-3 font-mono text-[11px] font-bold uppercase shadow-neo-sm"
        : "flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 transition-all hover:bg-fg/10 hover:text-fg"}
      title={installCmd}
    >
      {copied ? <Check size={mobile ? 18 : 13} className="text-green-600" /> : <TerminalSquare size={mobile ? 18 : 13} />}
      {copied ? "Copied install command" : "Copy CLI install command"}
    </button>
  );
}

function DesktopNav({ user, hash }: { user: ReturnType<typeof useAuth>["user"]; hash: string }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-5">
        <a href="#/" className="flex shrink-0 items-center gap-2 font-mono text-sm font-bold tracking-wider text-fg">
          <Terminal size={18} />
          <span>OCD</span>
          <span className="border border-fg px-1 py-0.5 font-mono text-[9px] font-bold uppercase">v0.4</span>
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
                className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${active ? "bg-fg text-accent" : "text-fg/70 hover:bg-fg/10 hover:text-fg"}`}
              >
                <Icon size={13} />{item.label}
              </a>
            );
          })}
          {user?.isAdmin && (
            <a href="#/admin" className={`flex items-center gap-1.5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${hash.startsWith("#/admin") ? "bg-fg text-accent" : "text-fg/70 hover:bg-fg/10 hover:text-fg"}`}>
              <Users size={13} />Admin
            </a>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center"><CliCopyButton /><SkillInstallMenu /></div>
        <div className="h-5 w-0.5 bg-fg/30" />
        <a href="#/account" className={`whitespace-nowrap px-2 py-1 font-mono text-[10px] transition-all ${hash.startsWith("#/account") ? "bg-fg text-accent" : "text-fg/70 hover:bg-fg/10 hover:text-fg"}`}>
          {user?.username}
          {user?.isAdmin && <span className="ml-1.5 border border-fg bg-fg px-1 py-0.5 font-mono text-[9px] font-bold uppercase text-accent">admin</span>}
        </a>
        <button onClick={() => { logout(); window.location.hash = "#/login"; }} className="p-1.5 text-fg/60 transition-all hover:text-accent-red" title="Logout"><LogOut size={14} /></button>
      </div>
    </>
  );
}

function CompactDesktopNav({ hash }: { hash: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <a href="#/" className="flex shrink-0 items-center gap-2 font-mono text-sm font-bold tracking-wider text-fg"><Terminal size={18} /><span>OCD</span></a>
      <div ref={ref} className="relative">
        <button onClick={() => setOpen(!open)} className="p-2 text-fg" aria-label="Menu"><Menu size={18} /></button>
        {open && (
          <div className="absolute right-0 top-full z-50 mt-1 w-56 border-2 border-fg bg-white shadow-neo">
            {navItems.map((item) => {
              const Icon = item.icon;
              return <a key={item.hash} href={item.hash} onClick={() => setOpen(false)} className={`flex items-center gap-2 px-3 py-2 font-mono text-xs font-bold uppercase ${item.match.test(hash) ? "bg-fg text-accent" : "text-fg"}`}><Icon size={13} />{item.label}</a>;
            })}
          </div>
        )}
      </div>
    </>
  );
}

function Row({ innerRef, children }: { innerRef?: React.Ref<HTMLDivElement>; children: ReactNode }) {
  return <div ref={innerRef} className="flex h-12 items-center justify-between gap-2">{children}</div>;
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
        <CliCopyButton mobile />
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
    <nav className="sticky top-0 z-50 border-b-2 border-fg bg-accent">
      <div className="relative mx-auto max-w-5xl px-4">
        <Row innerRef={containerRef}>{collapsed ? <CompactDesktopNav hash={hash} /> : <DesktopNav user={user} hash={hash} />}</Row>
        <div ref={ghostRef} aria-hidden className="pointer-events-none invisible absolute left-4 top-0" style={{ width: "max-content" }}>
          <div className="flex h-12 items-center gap-2"><DesktopNav user={user} hash={hash} /></div>
        </div>
      </div>
    </nav>
  );
}
