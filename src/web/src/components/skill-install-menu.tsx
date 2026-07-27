import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, Copy } from "lucide-react";
import { SKILL_AGENT_TARGETS } from "../../../shared/skill-agents.ts";
import { portalAnchorRect } from "./ui.tsx";

const MENU_WIDTH = 248;

export function SkillInstallMenu() {
  const [open, setOpen] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = portalAnchorRect(triggerRef.current);
      const left = Math.max(
        8,
        Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
      );
      setPosition({ top: rect.bottom + 4, left });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const copyInstallCommand = async (agent: string) => {
    const command = `ocd skill install --agent ${agent}`;
    await navigator.clipboard.writeText(command);
    setCopiedAgent(agent);
    setOpen(false);

    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedAgent(null);
      copiedTimerRef.current = null;
    }, 2000);
  };

  const copiedTarget = SKILL_AGENT_TARGETS.find(
    (agent) => agent.name === copiedAgent,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1.5 border-l border-fg/20 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
          open
            ? "bg-fg text-accent"
            : "text-fg/70 hover:bg-fg/10 hover:text-fg"
        }`}
        title={
          copiedTarget
            ? `Copied install command for ${copiedTarget.label}`
            : "Install the OCD skill for your coding agent"
        }
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {copiedAgent ? (
          <Check size={13} className="text-green-700" />
        ) : (
          <Bot size={13} />
        )}
        <span>{copiedAgent ? "Copied" : "Skill"}</span>
        {!copiedAgent && (
          <ChevronDown
            size={11}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            data-skill-install-menu
            role="menu"
            aria-label="Install OCD skill"
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: MENU_WIDTH,
            }}
            className="z-[60] border-2 border-fg bg-bg-raised shadow-neo"
          >
            <div className="border-b-2 border-fg bg-accent px-3 py-2">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-fg">
                Install agent skill
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-fg/60">
                Choose an agent to copy its command
              </div>
            </div>
            <div className="p-1">
              {SKILL_AGENT_TARGETS.map((agent) => {
                const command = `ocd skill install --agent ${agent.name}`;
                return (
                  <button
                    key={agent.name}
                    type="button"
                    role="menuitem"
                    onClick={() => void copyInstallCommand(agent.name)}
                    title={command}
                    className="group flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-alt focus:bg-alt focus:outline-none"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center border border-fg bg-bg-raised text-fg">
                      <Bot size={11} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[10px] font-bold text-fg">
                        {agent.label}
                      </span>
                      <span className="block font-mono text-[8px] text-muted">
                        --agent {agent.name}
                      </span>
                    </span>
                    <Copy
                      size={11}
                      className="shrink-0 text-muted transition-colors group-hover:text-fg"
                    />
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
