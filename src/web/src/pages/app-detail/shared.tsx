import { Info } from "lucide-react";

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center text-muted hover:text-fg cursor-help group">
      <Info size={11} />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-[9px] font-mono text-fg bg-bg border-2 border-fg shadow-neo-sm whitespace-normal max-w-[220px] w-max opacity-0 group-hover:opacity-100 transition-opacity z-50">
        {text}
      </span>
    </span>
  );
}

/** Format a memory figure (MiB) as MB or GB with sensible precision. */
function fmtMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

// Statuses in which a container is actually running and reporting live docker
// stats. Anything else (stopped/sleeping, paused, deploying) has no live usage
// — its stored numbers are stale, so we show nothing rather than mislead.
const LIVE_STATUSES = new Set(["running", "unhealthy"]);
const isLive = (status?: string) => status == null || LIVE_STATUSES.has(status);

/**
 * Render a container's CPU as "cores used / allowed vCPU" rather than a bare
 * percentage, which is ambiguous (docker's CPUPerc is percent of one core, so
 * 100% = one full core — not the whole server). Shows "—" for non-running
 * containers, and falls back to the percentage when the core ceiling hasn't
 * been collected yet.
 */
export function CpuUsage({ cpuPercent, limitCores, status }: { cpuPercent?: number; limitCores?: number; status?: string }) {
  if (!isLive(status) || cpuPercent == null) return <>—</>;
  const used = cpuPercent / 100;
  if (!limitCores) return <>{cpuPercent.toFixed(1)}%</>;
  return <>{used.toFixed(2)} / {limitCores} vCPU</>;
}

/**
 * Render a container's memory as "used / limit", where the limit is the
 * container's own `--memory` ceiling (docker's MemPerc is a fraction of that
 * ceiling, not of server RAM). Shows "—" for non-running containers, and falls
 * back to the percentage when absolute figures haven't been collected yet.
 */
export function MemUsage({ memoryPercent, usedMb, limitMb, status }: { memoryPercent?: number; usedMb?: number; limitMb?: number; status?: string }) {
  if (!isLive(status)) return <>—</>;
  if (usedMb != null && limitMb) return <>{fmtMem(usedMb)} / {fmtMem(limitMb)}</>;
  if (memoryPercent == null) return <>—</>;
  return <>{memoryPercent.toFixed(1)}%</>;
}

export function Sparkline({ values, color = "#3b82f6" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <span className="text-[9px] text-muted font-mono">no data</span>;
  const w = 120, h = 24;
  const max = Math.max(100, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
