// Pure metrics collection/parsing for the reconciler: one SSH batch per server
// turned into container + server-level resource samples. No DB writes — the
// reconciler applies the parsed results.

import { sshExec } from "../shared/remote/index.ts";
import type { ServerRow } from "../shared/db.ts";
import { TRAEFIK_METRICS_PORT } from "./scale/traefik-constants.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [reconciler:${context}]`, ...args);
}

/** One container's sampled resource use. `cpu`/`mem` are the raw docker-stats
 *  percentages (kept for the autoscaler); the absolute figures give the UI the
 *  "used of allowed" context that a bare percentage can't. `cpu` is percent of
 *  one core, so `cpu/100` is cores used; memory is in MiB. */
export type ContainerStat = {
  cpu: number;
  mem: number;
  memUsedMb: number;
  memLimitMb: number;
  cpuLimitCores: number;
};

/** Parse a docker-stats human size ("410.5MiB", "1.2GiB", "512B") into MiB. */
export function parseDockerSizeToMb(raw: string): number {
  const m = raw.trim().match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const perMib: Record<string, number> = {
    b: 1 / (1024 * 1024),
    kib: 1 / 1024,
    kb: 1 / 1024,
    mib: 1,
    mb: 1,
    gib: 1024,
    gb: 1024,
    tib: 1024 * 1024,
    tb: 1024 * 1024,
  };
  return value * (perMib[unit] ?? 1);
}

/** Parse docker stats JSON lines into a map of container_name -> ContainerStat.
 *  `MemUsage` ("410MiB / 512MiB") carries both the used and the per-container
 *  memory ceiling; the CPU ceiling isn't in stats and is merged in separately
 *  from `docker inspect` (see parseContainerLimits). */
export function parseDockerStats(stdout: string): Map<string, ContainerStat> {
  const result = new Map<string, ContainerStat>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const stats = JSON.parse(trimmed);
      const name = stats.Name as string;
      if (!name) continue;
      const cpu = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
      const mem = parseFloat(stats.MemPerc?.replace("%", "") || "0");
      let memUsedMb = 0, memLimitMb = 0;
      const usage = (stats.MemUsage as string | undefined)?.split("/");
      if (usage && usage.length === 2) {
        memUsedMb = Math.round(parseDockerSizeToMb(usage[0]) * 10) / 10;
        memLimitMb = Math.round(parseDockerSizeToMb(usage[1]) * 10) / 10;
      }
      result.set(name, { cpu, mem, memUsedMb, memLimitMb, cpuLimitCores: 0 });
    } catch {
      // skip malformed lines
    }
  }
  return result;
}

/** Parse `docker inspect` "<name> <nanocpus>" lines into container_name -> cpu
 *  core ceiling (NanoCpus/1e9; 0 means "unlimited"). Docker prefixes names with
 *  "/", which we strip to match the stats map keys. */
export function parseContainerLimits(stdout: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0].replace(/^\//, "");
    const nano = parseInt(parts[1], 10);
    if (!name || !Number.isFinite(nano)) continue;
    result.set(name, nano > 0 ? Math.round((nano / 1e9) * 100) / 100 : 0);
  }
  return result;
}

/** Parse server-level CPU, memory, and root-fs disk from top + /proc/meminfo + df output */
export function parseServerMetrics(stdout: string): { cpu: number; mem: number; diskUsedGb: number; diskTotalGb: number } | null {
  const lines = stdout.split("\n");
  const cpuLine = lines.find((l) => l.includes("Cpu"));
  let cpuPercent: number | null = null;
  if (cpuLine) {
    const idleMatch = cpuLine.match(/([\d.]+)\s*id/);
    if (idleMatch) cpuPercent = Math.round((100 - parseFloat(idleMatch[1])) * 10) / 10;
  }
  let memTotal = 0, memAvailable = 0;
  for (const line of lines) {
    const totalMatch = line.match(/MemTotal:\s+(\d+)/);
    const availMatch = line.match(/MemAvailable:\s+(\d+)/);
    if (totalMatch) memTotal = parseInt(totalMatch[1]);
    if (availMatch) memAvailable = parseInt(availMatch[1]);
  }
  const memPercent = memTotal > 0 ? Math.round((1 - memAvailable / memTotal) * 1000) / 10 : null;

  // df line format: "DISK <used_kib> <total_kib>"
  let diskUsedGb = 0, diskTotalGb = 0;
  const dfLine = lines.find((l) => l.startsWith("DISK "));
  if (dfLine) {
    const parts = dfLine.trim().split(/\s+/);
    const usedK = parseInt(parts[1] || "0", 10);
    const totalK = parseInt(parts[2] || "0", 10);
    if (usedK > 0) diskUsedGb = Math.round((usedK / 1024 / 1024) * 10) / 10;
    if (totalK > 0) diskTotalGb = Math.round((totalK / 1024 / 1024) * 10) / 10;
  }

  if (cpuPercent != null && memPercent != null) return { cpu: cpuPercent, mem: memPercent, diskUsedGb, diskTotalGb };
  return null;
}

/**
 * Single SSH call per server: collect docker stats for all containers, server
 * CPU/RAM, and Traefik's Prometheus request counters in one shot.
 */
export async function collectServerMetrics(
  server: ServerRow,
): Promise<{
  containerStats: Map<string, ContainerStat>;
  serverMetrics: { cpu: number; mem: number; diskUsedGb: number; diskTotalGb: number } | null;
  /** Raw Prometheus text from the local Traefik; null when the scrape failed. */
  traefikMetrics: string | null;
}> {
  const hostKey = server.ssh_host_key || undefined;
  const cmd = [
    `su - deploy -c "docker stats --no-stream --format '{{json .}}' 2>/dev/null"`,
    `echo '---LIMITS---'`,
    // Per-container CPU ceiling (NanoCpus). docker stats doesn't expose the
    // --cpus limit, so the UI's "cores used / allowed" needs this second read.
    // xargs -r avoids a bare `docker inspect` when no containers are running.
    `su - deploy -c "docker ps -q | xargs -r docker inspect --format '{{.Name}} {{.HostConfig.NanoCpus}}' 2>/dev/null"`,
    `echo '---SEPARATOR---'`,
    `top -bn1 | grep '%Cpu' | head -1`,
    `grep -E '^(MemTotal|MemAvailable):' /proc/meminfo`,
    `df -Pk / | awk 'NR==2 {print "DISK", $3, $2}'`,
    `echo '---TRAEFIK-METRICS---'`,
    // Subshell so a down/mid-upgrade Traefik doesn't fail the whole batch; an
    // empty metrics section is a failed scrape (never treated as zero traffic).
    `(curl -sf --max-time 5 http://127.0.0.1:${TRAEFIK_METRICS_PORT}/metrics || true)`,
  ].join(" && ");

  try {
    const result = await sshExec(server.ipv4, cmd, hostKey);
    if (result.exitCode !== 0) return { containerStats: new Map(), serverMetrics: null, traefikMetrics: null };

    const [dockerPart, afterDocker] = result.stdout.split("---LIMITS---");
    const [limitsPart, rest] = (afterDocker || "").split("---SEPARATOR---");
    const [metricsPart, traefikPart] = (rest || "").split("---TRAEFIK-METRICS---");
    const containerStats = parseDockerStats(dockerPart || "");
    const cpuLimits = parseContainerLimits(limitsPart || "");
    for (const [name, cores] of cpuLimits) {
      const stat = containerStats.get(name);
      if (stat) stat.cpuLimitCores = cores;
    }
    const serverMetrics = parseServerMetrics(metricsPart || "");
    return { containerStats, serverMetrics, traefikMetrics: traefikPart?.trim() ? traefikPart : null };
  } catch (err) {
    log("metrics", `server ${server.ipv4}: ${err}`);
    return { containerStats: new Map(), serverMetrics: null, traefikMetrics: null };
  }
}
