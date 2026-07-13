import type { ReactNode } from "react";
import { Pause } from "lucide-react";

export function PausedBanner({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 mb-4 border-2 border-fg bg-alt">
      <Pause size={12} className="text-muted" />
      <span className="font-mono text-[10px] text-muted font-bold uppercase tracking-wider">
        {message}
      </span>
      {children && <div className="ml-auto">{children}</div>}
    </div>
  );
}
