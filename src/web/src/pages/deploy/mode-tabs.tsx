import { Rocket, Boxes } from "lucide-react";
import { useHasPermission } from "../../stores/auth.ts";

// Single App / Stack switcher shown at the top of the Deploy page. Hidden
// entirely for users without stacks.deploy so the page reads exactly as before
// for them.
export function DeployModeTabs({ active }: { active: "app" | "stack" }) {
  const canStack = useHasPermission("stacks.deploy");
  if (!canStack) return null;

  const tab = (
    mode: "app" | "stack",
    href: string,
    label: string,
    Icon: typeof Rocket,
  ) => {
    const on = active === mode;
    return (
      <a
        href={href}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg transition-colors ${
          on ? "bg-accent text-fg shadow-neo-sm" : "bg-bg-raised text-fg-dim hover:bg-alt"
        }`}
      >
        <Icon size={12} /> {label}
      </a>
    );
  };

  return (
    <div className="flex items-center gap-2 mb-5">
      {tab("app", "#/deploy", "Single App", Rocket)}
      {tab("stack", "#/deploy/stack", "Stack", Boxes)}
    </div>
  );
}
