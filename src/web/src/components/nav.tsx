import { useEffect, useState, type ReactNode } from "react";
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
      className="flex items-center gap-1 px-1.5 py-1 font-mono text-[9px] font-bold uppercase tracking-wide text-fg/70 hover:text-fg hover:bg-fg/10 transition-all"
      title={installCmd}
    >
      {copied ? <Check size={12} className="text-green-600" /> : <TerminalSquare size={12} />}
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

function DesktopNav({ user, hash }: { user: ReturnType<typeof useAuth>["user"]; hash: string }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <a href="#/" className="flex shrink-0 items-center gap-1.5 font-mono text-xs font-bold tracking-wide text-fg">
          <Terminal size={16} />
          <span>OCD</span>
          <span className="border border-fg px-1 py-0.5 font-mono text-[8px] font-bold uppercase">v0.4</span>
        </a>
        <div className="h-4 w-px shrink-0 bg-fg/30" />
        <div className="flex items-center">
          {navItems.map((item) => {
            const active = item.match.test(hash);
            const Icon = item.icon;
            return (
              <a
                key={item.hash}
                href={item.hash}
                className={`flex items-center gap-1 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wide transition-all ${
                  active ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
                }`}
              >
                <Icon size={12} />
                {item.label}
              </a>
            );
          })}
          {user?.isAdmin && (
            <a
              href="#/admin"
              className={`flex items-center gap-1 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-wide transition-all ${
                hash.startsWith("#/admin") ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
              }`}
            >
              <Users size={12} />
              Admin
            </a>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex items-center">
          <CliCopyButton />
          <SkillInstallMenu />
        </div>
        <div className="h-4 w-px bg-fg/30" />
        <a
          href="#/account"
          className={`flex max-w-40 items-center px-1.5 py-1 font-mono text-[9px] transition-all ${
            hash.startsWith("#/account") ? "bg-fg text-accent" : "text-fg/70 hover:text-fg hover:bg-fg/10"
          }`}
        >
          <span className="truncate">{user?.username}</span>
          {user?.isAdmin && (
            <span className="ml-1 shrink-0 border border-fg bg-fg px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-accent">
              admin
            </span>
          )}
        </a>
        <button
          onClick={() => { logout(); window.location.hash = "#/login"; }}
          className="p-1 text-fg/60 hover:text-accent-red transition-all"
          title="Logout"
        >
          <LogOut size={13} />
        </button>
      </div>
    </>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-12 min-w-max items-center justify-between gap-1">
      {children}
    </div>
  );
}

function MobileNav({ hash }: { hash: string }) {
  const { user } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [hash]);

  const primaryItems = [
    { hash: "#/", label: "Home", icon: Home, active: /^#\/?$/.test(hash) || /^#\/(apps|stacks)\//.test(hash) },
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
          <button onClick={() => setMoreOpen(true)} className={`flex flex-col items-center justify-center gap-1 font-mono text-[9px] font-bold uppercase ${moreOpen || hash.startsWith("#/environments") || hash.startsWith("#/engine") || hash.startsWith("#/admin") || hash.startsWith("#/account") ? "bg-accent text-fg" : "text-muted"}`}>
            <Menu size={20} /><span>More</span>
          </button>
        </div>
      </nav>

      <MobileActionSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="OCD Menu" subtitle={user?.username}>
        <MobileSheetAction icon={<Layers size={19} />} label="Environments" detail="Variables, secrets, and rollout behavior" onClick={() => { window.location.hash = "#/environments"; }} />
        <MobileSheetAction icon={<Cpu size={19} />} label="Operations" detail="Progress, logs, and recovery actions" onClick={() => { window.location.hash = "#/engine"; }} />
        {user?.isAdmin && <MobileSheetAction icon={<Users size={19} />} label="Admin" detail="Setup, integrations, and users" onClick={() => { window.location.hash = "#/admin"; }} />}
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

  if (isMobile) return <MobileNav hash={hash} />;

  return (
    <nav className="sticky top-0 z-50 overflow-x-auto bg-accent border-b-2 border-fg">
      <div className="mx-auto max-w-6xl px-2 xl:px-3">
        <Row>
          <DesktopNav user={user} hash={hash} />
        </Row>
      </div>
    </nav>
  );
}
