import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../scheduler.ts";
import { wasProxyEverReady } from "./proxy-manager.ts";
import { appHostsLine } from "./proxy-render.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [net-recon:${context}]`, ...args);
}

/**
 * Reconcile host-local name resolution. Provider network attachment and the
 * authoritative private address are owned by infrastructure-reconciler; this
 * controller only consumes ready server state and writes /etc/hosts.
 */
export async function reconcileNetwork(): Promise<void> {
  try {
    await syncInternalHosts();
  } catch (err) {
    log("hosts", `sync failed: ${err}`);
  }
}

/**
 * Build /etc/hosts lines and push into /etc/hosts on every materialized
 * server:
 *
 *   - `<app>.ocd.internal`      → the app's fleet-wide virtual IP (ocd-proxy)
 *
 * App entries point at per-app VIPs, terminated on loopback by each server's
 * local ocd-proxy. The gate is per-server and sticky (wasProxyEverReady): a
 * server only gets app lines once a converge has proven its proxy live, and
 * a later converge failure keeps the last-known-good VIP lines — the proxy
 * almost certainly still runs with its previous config. There is NO
 * private-IP fallback line anymore: the port-based Traefik internal ingress
 * it pointed at was torn down, so such a line would route to a closed port
 * (see appHostsLine).
 *
 * Idempotent — the block is delimited by BEGIN/END markers so repeated
 * runs just overwrite the same region.
 */

export async function syncInternalHosts(): Promise<void> {
  const panel = db.getPanel();
  if (!panel) return;

  const apps = db.getApps();
  const servers = db.getServers().filter((s) => s.ipv4 && s.status === "ready");
  for (const snapshot of servers) {
    const keys = [`server:${snapshot.id}`];
    const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:hosts");
    if (!lock.ok) continue;
    try {
      const server = db.getServer(snapshot.id);
      if (!server?.ipv4 || server.status !== "ready") continue;
      const lines: string[] = [];
      if (server.private_ipv4) {
        const everReady = wasProxyEverReady(server.ipv4);
        for (const app of apps) {
          const line = appHostsLine(app, server.private_ipv4, everReady);
          if (line) lines.push(line);
        }
      }
      try {
        await writeHostsBlock(server.ipv4, lines.join("\n"), server.ssh_host_key || undefined);
      } catch (err) {
        log("hosts", `Failed to update /etc/hosts on ${server.name}: ${err}`);
      }
    } finally {
      release(keys);
    }
  }
}

const HOSTS_BEGIN = "# BEGIN ocd-internal";
const HOSTS_END = "# END ocd-internal";

async function writeHostsBlock(
  serverIp: string,
  block: string,
  hostKey: string | undefined,
): Promise<void> {
  // Rewrite /etc/hosts: strip any existing BEGIN/END ocd-internal region and
  // append the fresh block. awk is available on every Ubuntu image so we
  // avoid a Python/sed portability rabbit hole.
  const newBody = block.length > 0
    ? `${HOSTS_BEGIN}\n${block}\n${HOSTS_END}`
    : `${HOSTS_BEGIN}\n${HOSTS_END}`;
  const escaped = newBody.replace(/'/g, "'\\''");
  const cmd = `set -e
tmp=$(mktemp)
awk -v b='${HOSTS_BEGIN}' -v e='${HOSTS_END}' '
  $0==b {skip=1; next}
  $0==e && skip==1 {skip=0; next}
  skip==0 {print}
' /etc/hosts > "$tmp"
printf '%s\\n' '${escaped}' >> "$tmp"
cat "$tmp" > /etc/hosts
rm -f "$tmp"`;
  await sshExec(serverIp, cmd, hostKey);
}
