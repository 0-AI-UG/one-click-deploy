import { Checkbox, Field, InfoTip } from "../../components/ui";
export { InfoTip };

/**
 * The app's HTTP health check, as one control shared by the deploy form and the
 * settings tab. `health_check` is the master switch — it gates both the
 * post-deploy/scale probe and Traefik's continuous rotation check — and
 * `health_check_path` is the single path both of those probes request (blank =
 * the root `/` for the deploy probe; Traefik's continuous check needs an
 * explicit path). They used to be two separate fields that read as duplicates;
 * keeping them in one component here is what keeps the two pages in sync.
 * `onChange` hands back both values so each page maps them into its own state.
 */
export function HealthCheckField({
  enabled,
  path,
  onChange,
}: {
  enabled: boolean;
  path: string;
  onChange: (next: { health_check: boolean; health_check_path: string }) => void;
}) {
  return (
    <Field
      align="start"
      label="Health check"
      hint="Checks that the app answers HTTP after deploys and while running. Failing replicas restart or leave rotation. Turn it off for non-HTTP apps. Changes apply on the next deploy or scale."
    >
      <div className="space-y-2">
        <div className="flex justify-start">
          <Checkbox
            checked={enabled}
            onChange={(v) => onChange({ health_check: v, health_check_path: v ? path : "" })}
            label="Check over HTTP"
          />
        </div>
        {enabled && (
          <input
            type="text"
            value={path}
            onChange={(e) => onChange({ health_check: enabled, health_check_path: e.target.value })}
            placeholder="/healthz (blank probes /)"
          />
        )}
      </div>
    </Field>
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
  let text = "—";
  if (isLive(status) && cpuPercent != null) {
    text = limitCores ? `${(cpuPercent / 100).toFixed(2)} / ${limitCores} vCPU` : `${cpuPercent.toFixed(1)}%`;
  }
  // Smaller than the table baseline so "used / allowed" fits the width the bare
  // percentage used to occupy.
  return <span className="text-[10px]">{text}</span>;
}

/**
 * Render a container's memory as "used / limit", where the limit is the
 * container's own `--memory` ceiling (docker's MemPerc is a fraction of that
 * ceiling, not of server RAM). Shows "—" for non-running containers, and falls
 * back to the percentage when absolute figures haven't been collected yet.
 */
export function MemUsage({ memoryPercent, usedMb, limitMb, status }: { memoryPercent?: number; usedMb?: number; limitMb?: number; status?: string }) {
  let text = "—";
  if (isLive(status)) {
    if (usedMb != null && limitMb) text = `${fmtMem(usedMb)} / ${fmtMem(limitMb)}`;
    else if (memoryPercent != null) text = `${memoryPercent.toFixed(1)}%`;
  }
  return <span className="text-[10px]">{text}</span>;
}

export function Sparkline({ values, color = "#5B8DEF" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <span className="text-[9px] text-muted font-mono">no data</span>;
  const w = 120, h = 24;
  const max = Math.max(100, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block" role="img" aria-label="Recent metric trend">
      <title>Recent metric trend</title>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}
