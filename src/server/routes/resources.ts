import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { sshExec } from "../../shared/remote/index.ts";
export async function handleGetResources(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");

    const compute = hetzner;

    // Fetch pricing once and build lookup maps.
    // If pricing fetch fails (no token, network), monthly_eur falls back to null.
    let serverPriceMap = new Map<string, number>();
    let volumePerGbMonth: number | null = null;
    let currency = "EUR";
    try {
      const pricing = await compute.getPricing?.();
      if (pricing) {
        currency = pricing.currency;
        for (const [key, value] of Object.entries(pricing.servers)) {
          serverPriceMap.set(key, value);
        }
        volumePerGbMonth = pricing.volumePerGbMonth;
      }
    } catch (e) {
      console.error("resources: failed to fetch pricing:", e);
    }

    const priceForServer = (type: string, location: string): number | null =>
      serverPriceMap.get(`${type}|${location}`) ?? null;
    let dbServers = db.getServers();
    try {
      const remoteServers = await compute.listServers();
      for (const rs of remoteServers) {
        const providerId = String(rs.providerId);
        if (dbServers.find((s) => s.provider_id === providerId)) continue;
        db.insertServer({
          name: rs.name,
          provider_id: providerId,
          ipv4: rs.ipv4 || "",
          ipv6: rs.ipv6 || "",
          type: rs.type || "",
          location: rs.location || "",
          status: rs.status || "running",
        });
      }
      dbServers = db.getServers();
    } catch (e) {
      console.error("resources: failed to sync servers from provider:", e);
    }

    // Get latest metric sample per server from the reconciler-collected history
    const recentMetrics = db.getRecentServerMetrics(120); // last 2 minutes
    const latestByServer = new Map<number, { cpu_percent: number; memory_percent: number; disk_used_gb: number; disk_total_gb: number }>();
    for (const m of recentMetrics) {
      latestByServer.set(m.server_id, {
        cpu_percent: m.cpu_percent,
        memory_percent: m.memory_percent,
        disk_used_gb: m.disk_used_gb,
        disk_total_gb: m.disk_total_gb,
      });
    }

    const servers = dbServers.map((s) => {
      const usage = latestByServer.get(s.id);
      return {
        id: s.id,
        name: s.name,
        provider_id: s.provider_id,
        ipv4: s.ipv4,
        type: s.type,
        location: s.location,
        status: s.status,
        cpu_percent: usage?.cpu_percent ?? null,
        memory_percent: usage?.memory_percent ?? null,
        disk_used_gb: usage?.disk_used_gb && usage.disk_used_gb > 0 ? usage.disk_used_gb : null,
        disk_total_gb: usage?.disk_total_gb && usage.disk_total_gb > 0 ? usage.disk_total_gb : null,
        disk_free_gb: usage?.disk_total_gb && usage.disk_total_gb > 0
          ? Math.round((usage.disk_total_gb - usage.disk_used_gb) * 10) / 10
          : null,
        replica_count: db.getReplicasByServer(s.id).length,
        monthly_eur: priceForServer(s.type, s.location),
      };
    });

    interface VolumeResource {
      id: string;
      name: string;
      size: number;
      server_name: string;
      app_name: string;
      location: string;
      app_id: number;
      monthly_eur: number | null;
    }

    let volumes: VolumeResource[] = [];
    try {
      const vols = await compute.volumes?.list() ?? [];
      const allApps = db.getApps();
      volumes = vols.map((v) => {
        const serverName = v.serverId ? dbServers.find((s) => s.provider_id === v.serverId)?.name || `server-${v.serverId}` : "";
        const app = allApps.find((a) => a.volume_id === v.providerId);
        return {
          id: v.providerId,
          name: v.name,
          size: v.sizeGb,
          server_name: serverName,
          app_name: app?.name || "",
          location: v.location,
          app_id: app?.id || 0,
          monthly_eur: volumePerGbMonth != null ? volumePerGbMonth * v.sizeGb : null,
        };
      });
    } catch (e) {
      console.error("resources: failed to fetch volumes:", e);
    }

    interface ResourceWithCost { monthly_eur: number | null }
    const sum = (arr: ResourceWithCost[]) =>
      arr.reduce((acc, x) => acc + (typeof x.monthly_eur === "number" ? x.monthly_eur : 0), 0);
    const totals = {
      currency,
      servers: sum(servers),
      volumes: sum(volumes),
      total: sum(servers) + sum(volumes),
    };

    return Response.json({ servers, volumes, totals }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServerMetricsHistory(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "3600", 10);
    const samples = db.getRecentServerMetrics(since);
    return Response.json(samples, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteResource(request: Request, type: string, id: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.delete");
    const compute = hetzner;

    if (type === "server") {
      const payload = await requirePermission(request, "resources.delete");
      const server = db.getServers().find((s) => s.provider_id === id || String(s.id) === id);
      if (server) {
        const replicas = db.getReplicasByServer(server.id);
        if (replicas.length > 0) {
          const users = replicas.map((r) => `${r.container_name} (replica)`);
          return Response.json({ ok: false, error: `Server is in use by: ${users.join(", ")}` }, { headers: corsHeaders });
        }
        const apps = db.getApps(server.id);
        const services = db.getServicesOnServer(server.id);
        const keys = [
          `server:${server.id}`,
          ...apps.map((a) => `app:${a.id}`),
          ...services.map((s) => `service:${s.id}`),
        ];
        const { opId } = enqueue({
          kind: "destroy_server",
          resourceKeys: keys,
          input: { serverId: server.id },
          trigger: "ui",
          triggeredBy: payload.userId,
        });
        return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
      }
      await compute.deleteServer(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    } else if (type === "volume") {
      const allApps = db.getApps();
      const using = allApps.filter((a) => a.volume_id === id);
      if (using.length > 0) {
        return Response.json({ ok: false, error: `Volume is in use by: ${using.map((a) => a.name).join(", ")}` }, { headers: corsHeaders });
      }
      await compute.volumes!.delete(id);
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    return Response.json({ ok: false, error: "Unknown resource type" }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Resolve the host mount path for a Hetzner-style volume given its provider id.
 * Returns null when the volume is unattached or we can't find any app using it
 * (i.e. no record of where it was mounted).
 */
async function resolveVolumeMount(volumeId: string): Promise<
  | { ok: true; server: ReturnType<typeof db.getServer> & {}; hostPath: string; volume: { providerId: string; name: string; sizeGb: number; location: string; serverId: string | null } }
  | { ok: false; error: string; status?: number; volume?: { providerId: string; name: string; sizeGb: number; location: string; serverId: string | null } }
> {
  const compute = hetzner;
  let volume;
  try {
    volume = await compute.volumes!.get(volumeId);
  } catch {
    return { ok: false, error: "Volume not found", status: 404 };
  }
  if (!volume.serverId) {
    return { ok: false, error: "Volume is not attached to a server", status: 409, volume };
  }
  const server = db.getServers().find((s) => s.provider_id === volume.serverId);
  if (!server) {
    return { ok: false, error: "Volume's server is not tracked locally", status: 404, volume };
  }
  // Prefer the host-path recorded on the consuming app's volume_mount.
  const app = db.getApps().find((a) => a.volume_id === volumeId);
  const hostPath = app?.volume_mount?.split(":")[0] || `/mnt/ocd-${volume.name}-data`;
  return { ok: true, server, hostPath, volume };
}

function safeJoin(base: string, sub: string): string | null {
  // Normalize: collapse repeated slashes, strip leading slash from sub, reject .. parts.
  const cleaned = (sub || "").replace(/^\/+/, "").split("/").filter(Boolean);
  for (const p of cleaned) {
    if (p === "..") return null;
  }
  return cleaned.length ? `${base}/${cleaned.join("/")}` : base;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function handleGetVolumeDetail(request: Request, volumeId: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const compute = hetzner;
    let volume;
    try {
      volume = await compute.volumes!.get(volumeId);
    } catch {
      return Response.json({ error: "Volume not found" }, { status: 404, headers: corsHeaders });
    }
    const dbServers = db.getServers();
    const server = volume.serverId ? dbServers.find((s) => s.provider_id === volume.serverId) || null : null;
    const app = db.getApps().find((a) => a.volume_id === volumeId) || null;
    const hostPath = app?.volume_mount?.split(":")[0] || (volume.serverId ? `/mnt/ocd-${volume.name}-data` : null);
    let pricing;
    try { pricing = await compute.getPricing?.(); } catch { /* ignore */ }
    const monthly_eur = pricing?.volumePerGbMonth != null ? pricing.volumePerGbMonth * volume.sizeGb : null;
    return Response.json({
      id: volume.providerId,
      name: volume.name,
      size: volume.sizeGb,
      location: volume.location,
      server_name: server?.name || null,
      server_id: server?.id || null,
      app_name: app?.name || null,
      app_id: app?.id || null,
      host_path: hostPath,
      monthly_eur,
      attached: !!volume.serverId,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleListVolumeFiles(request: Request, volumeId: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const url = new URL(request.url);
    const subPath = url.searchParams.get("path") || "";

    const resolved = await resolveVolumeMount(volumeId);
    if (!resolved.ok) {
      return Response.json({ error: resolved.error }, { status: resolved.status || 400, headers: corsHeaders });
    }
    const target = safeJoin(resolved.hostPath, subPath);
    if (!target) {
      return Response.json({ error: "Invalid path" }, { status: 400, headers: corsHeaders });
    }
    // Print one entry per line: type|size|mtime|name. Use stat for portability.
    const cmd = `cd ${shellQuote(target)} && ls -A1 | while IFS= read -r f; do
  if [ -L "$f" ]; then t=l; elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; else t=o; fi
  sz=$(stat -c%s -- "$f" 2>/dev/null || echo 0)
  mt=$(stat -c%Y -- "$f" 2>/dev/null || echo 0)
  printf '%s|%s|%s|%s\\n' "$t" "$sz" "$mt" "$f"
done`;
    const { stdout, stderr, exitCode } = await sshExec(resolved.server.ipv4, cmd, resolved.server.ssh_host_key || undefined);
    if (exitCode !== 0) {
      return Response.json({ error: stderr.trim() || "Failed to list directory" }, { status: 500, headers: corsHeaders });
    }
    const entries = stdout.split("\n").filter(Boolean).map((line) => {
      const idx1 = line.indexOf("|");
      const idx2 = line.indexOf("|", idx1 + 1);
      const idx3 = line.indexOf("|", idx2 + 1);
      const type = line.slice(0, idx1);
      const size = parseInt(line.slice(idx1 + 1, idx2), 10) || 0;
      const mtime = parseInt(line.slice(idx2 + 1, idx3), 10) || 0;
      const name = line.slice(idx3 + 1);
      return { name, type, size, mtime };
    });
    entries.sort((a, b) => {
      if ((a.type === "d") !== (b.type === "d")) return a.type === "d" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return Response.json({ host_path: resolved.hostPath, path: subPath, entries }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

const FILE_VIEW_MAX_BYTES = 256 * 1024;

export async function handleGetVolumeFile(request: Request, volumeId: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const url = new URL(request.url);
    const subPath = url.searchParams.get("path") || "";
    if (!subPath) {
      return Response.json({ error: "path required" }, { status: 400, headers: corsHeaders });
    }
    const resolved = await resolveVolumeMount(volumeId);
    if (!resolved.ok) {
      return Response.json({ error: resolved.error }, { status: resolved.status || 400, headers: corsHeaders });
    }
    const target = safeJoin(resolved.hostPath, subPath);
    if (!target) {
      return Response.json({ error: "Invalid path" }, { status: 400, headers: corsHeaders });
    }
    // First stat: only read regular files within size limit.
    const cmd = `if [ ! -f ${shellQuote(target)} ]; then echo NOTFILE; exit 0; fi
size=$(stat -c%s -- ${shellQuote(target)} 2>/dev/null || echo 0)
echo "SIZE:$size"
head -c ${FILE_VIEW_MAX_BYTES + 1} -- ${shellQuote(target)} | base64`;
    const { stdout, stderr, exitCode } = await sshExec(resolved.server.ipv4, cmd, resolved.server.ssh_host_key || undefined);
    if (exitCode !== 0) {
      return Response.json({ error: stderr.trim() || "Failed to read file" }, { status: 500, headers: corsHeaders });
    }
    if (stdout.startsWith("NOTFILE")) {
      return Response.json({ error: "Not a regular file" }, { status: 400, headers: corsHeaders });
    }
    const firstNl = stdout.indexOf("\n");
    const sizeLine = stdout.slice(0, firstNl);
    const b64 = stdout.slice(firstNl + 1).replace(/\s+/g, "");
    const size = parseInt(sizeLine.replace("SIZE:", ""), 10) || 0;
    const buf = Buffer.from(b64, "base64");
    const truncated = size > FILE_VIEW_MAX_BYTES;
    const slice = truncated ? buf.subarray(0, FILE_VIEW_MAX_BYTES) : buf;
    // Detect binary by NUL byte presence.
    const isBinary = slice.includes(0);
    return Response.json({
      path: subPath,
      size,
      truncated,
      binary: isBinary,
      content: isBinary ? null : slice.toString("utf8"),
      max_bytes: FILE_VIEW_MAX_BYTES,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

type HostProbe = {
  uptime_seconds: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_cores: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  mem_free_mb: number | null;
  mem_available_mb: number | null;
  mem_buffers_cache_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  processes: number | null;
  ports: { proto: string; address: string; port: number; process: string }[];
  net: { iface: string; rx_bytes: number; tx_bytes: number } | null;
  error: string | null;
};

const PROBE_SEP = "###OCD_SECTION###";

async function probeServerHost(server: { ipv4: string; ssh_host_key: string }): Promise<HostProbe> {
  const empty: HostProbe = {
    uptime_seconds: null, load1: null, load5: null, load15: null, cpu_cores: null,
    mem_total_mb: null, mem_used_mb: null, mem_free_mb: null, mem_available_mb: null,
    mem_buffers_cache_mb: null, swap_total_mb: null, swap_used_mb: null,
    processes: null, ports: [], net: null, error: null,
  };
  if (!server.ipv4) return { ...empty, error: "no ipv4" };

  // One SSH round-trip — print labeled sections separated by PROBE_SEP.
  const cmd = [
    `cat /proc/uptime`,
    `echo '${PROBE_SEP}'`,
    `cat /proc/loadavg`,
    `echo '${PROBE_SEP}'`,
    `nproc`,
    `echo '${PROBE_SEP}'`,
    `cat /proc/meminfo`,
    `echo '${PROBE_SEP}'`,
    `ls /proc | grep -E '^[0-9]+$' | wc -l`,
    `echo '${PROBE_SEP}'`,
    // ss -H suppresses header; -tlnp gives TCP listeners with process info.
    // Fallback to plain `ss -tln` if `-p` requires root and fails.
    `(ss -Htlnp 2>/dev/null || ss -Htln) | head -200`,
    `echo '${PROBE_SEP}'`,
    // Pick first non-lo interface and print rx/tx bytes.
    `awk -F'[: ]+' 'NR>2 && $2 != "lo" {print $2, $3, $11; exit}' /proc/net/dev`,
  ].join("; ");

  try {
    const result = await sshExec(server.ipv4, cmd, server.ssh_host_key || undefined);
    if (result.exitCode !== 0) {
      return { ...empty, error: result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}` };
    }
    const parts = result.stdout.split(PROBE_SEP).map((p) => p.trim());
    const [uptimeStr, loadStr, nprocStr, meminfoStr, procsStr, ssStr, netStr] = parts;

    const uptime_seconds = uptimeStr ? Math.round(parseFloat(uptimeStr.split(/\s+/)[0])) : null;

    let load1: number | null = null, load5: number | null = null, load15: number | null = null;
    if (loadStr) {
      const lp = loadStr.split(/\s+/);
      load1 = parseFloat(lp[0]); load5 = parseFloat(lp[1]); load15 = parseFloat(lp[2]);
    }

    const cpu_cores = nprocStr ? parseInt(nprocStr, 10) : null;

    const meminfo: Record<string, number> = {};
    for (const line of (meminfoStr || "").split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
      if (m) meminfo[m[1]] = parseInt(m[2], 10);
    }
    const kbToMb = (kb: number | undefined) => kb != null ? Math.round(kb / 1024) : null;
    const mem_total_mb = kbToMb(meminfo.MemTotal);
    const mem_free_mb = kbToMb(meminfo.MemFree);
    const mem_available_mb = kbToMb(meminfo.MemAvailable);
    const mem_buffers_cache_mb = kbToMb((meminfo.Buffers || 0) + (meminfo.Cached || 0) + (meminfo.SReclaimable || 0));
    const mem_used_mb = mem_total_mb != null && mem_available_mb != null
      ? Math.max(0, mem_total_mb - mem_available_mb) : null;
    const swap_total_mb = kbToMb(meminfo.SwapTotal);
    const swap_used_mb = meminfo.SwapTotal != null && meminfo.SwapFree != null
      ? kbToMb(meminfo.SwapTotal - meminfo.SwapFree) : null;

    const processes = procsStr ? parseInt(procsStr, 10) : null;

    // ss -tlnp lines look like:
    //   LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("traefik",pid=123,fd=7))
    //   LISTEN 0 4096 *:22 *:*
    const ports: HostProbe["ports"] = [];
    const seen = new Set<string>();
    for (const line of (ssStr || "").split("\n")) {
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 4) continue;
      const local = tokens[3];
      const idx = local.lastIndexOf(":");
      if (idx < 0) continue;
      const address = local.slice(0, idx) || "*";
      const port = parseInt(local.slice(idx + 1), 10);
      if (!port) continue;
      let process = "";
      const usersIdx = line.indexOf("users:(");
      if (usersIdx >= 0) {
        const m = line.slice(usersIdx).match(/"([^"]+)"/);
        if (m) process = m[1];
      }
      const key = `tcp:${address}:${port}:${process}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push({ proto: "tcp", address, port, process });
    }
    ports.sort((a, b) => a.port - b.port);

    let net: HostProbe["net"] = null;
    if (netStr) {
      const np = netStr.split(/\s+/);
      if (np.length >= 3) {
        net = { iface: np[0], rx_bytes: parseInt(np[1], 10) || 0, tx_bytes: parseInt(np[2], 10) || 0 };
      }
    }

    return {
      uptime_seconds, load1, load5, load15, cpu_cores,
      mem_total_mb, mem_used_mb, mem_free_mb, mem_available_mb, mem_buffers_cache_mb,
      swap_total_mb, swap_used_mb, processes, ports, net, error: null,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleGetServerDetail(request: Request, serverId: number): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const server = db.getServer(serverId);
    if (!server) {
      return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    }

    const compute = hetzner;
    let monthly_eur: number | null = null;
    let currency = "EUR";
    try {
      const pricing = await compute.getPricing?.();
      if (pricing) {
        currency = pricing.currency;
        monthly_eur = pricing.servers[`${server.type}|${server.location}`] ?? null;
      }
    } catch { /* ignore */ }

    const recentMetrics = db.getRecentServerMetrics(120);
    const latest = [...recentMetrics].reverse().find((m) => m.server_id === serverId);

    // Live probe of the host — runs in parallel with the rest.
    const probePromise = probeServerHost(server);

    const replicaRows = db.getReplicasByServer(serverId);
    const replicaMetrics = db.getRecentMetricsByReplicas(replicaRows.map((r) => r.id), 3600);
    const allApps = db.getApps();
    const appById = new Map(allApps.map((a) => [a.id, a]));
    const replicas = replicaRows.map((r) => {
      const app = appById.get(r.app_id);
      return {
        id: r.id,
        app_id: r.app_id,
        app_name: app?.name || `app-${r.app_id}`,
        container_name: r.container_name,
        host_port: r.host_port,
        status: r.status,
        cpu_percent: r.cpu_percent,
        memory_percent: r.memory_percent,
        created_at: r.created_at,
      };
    });

    const services = db.getServicesOnServer(serverId).map((s) => {
      const instances = db.getServiceInstancesByServer(serverId).filter((i) => i.service_id === s.id);
      return {
        id: s.id,
        name: s.name,
        service_type: s.service_type,
        version: s.version,
        status: s.status,
        instances: instances.map((i) => ({
          id: i.id,
          role: i.role,
          container_name: i.container_name,
          host_port: i.host_port,
          status: i.status,
          cpu_percent: i.cpu_percent,
          memory_percent: i.memory_percent,
        })),
      };
    });

    return Response.json({
      id: server.id,
      name: server.name,
      provider_id: server.provider_id,
      ipv4: server.ipv4,
      ipv6: server.ipv6,
      private_ipv4: server.private_ipv4,
      type: server.type,
      location: server.location,
      status: server.status,
      created_at: server.created_at,
      monthly_eur,
      currency,
      cpu_percent: latest?.cpu_percent ?? null,
      memory_percent: latest?.memory_percent ?? null,
      disk_used_gb: latest?.disk_used_gb && latest.disk_used_gb > 0 ? latest.disk_used_gb : null,
      disk_total_gb: latest?.disk_total_gb && latest.disk_total_gb > 0 ? latest.disk_total_gb : null,
      disk_free_gb: latest?.disk_total_gb && latest.disk_total_gb > 0
        ? Math.round((latest.disk_total_gb - latest.disk_used_gb) * 10) / 10
        : null,
      replicas,
      replica_metrics: replicaMetrics,
      services,
      host: await probePromise,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateServer(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "resources.create");
    const body = await request.json() as { server_type: string; location: string; name?: string };

    if (!body.server_type || !body.location) {
      return Response.json({ error: "server_type and location are required" }, { status: 400, headers: corsHeaders });
    }

    const { opId } = enqueue({
      kind: "provision_server",
      resourceKeys: ["create-server"],
      input: {
        serverType: body.server_type,
        location: body.location,
        name: body.name,
      },
      trigger: "ui",
      triggeredBy: payload.userId,
    });

    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
