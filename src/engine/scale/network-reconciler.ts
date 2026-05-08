import * as db from "../../shared/db.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { ensureNetwork as ensureSharedNetwork } from "../network.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [net-recon:${context}]`, ...args);
}

/**
 * Reconciler pass that drags every server onto the shared private network
 * and keeps each server's /etc/hosts in sync with the `<app>.ocd.internal`
 * convention used by intra-app traffic. App entries point at 127.0.0.1 —
 * each server runs its own Caddy srv_internal that reverse-proxies to the
 * replica pool over the private network.
 *
 * Runs inside the main reconciler tick, after replica/health work. Completes
 * in a few provider calls per new server and skips fast when everything is
 * already up to date.
 */
export async function reconcileNetwork(): Promise<void> {
  const compute = getComputeProvider();
  if (!compute.networks) return; // provider doesn't support private networking

  let networkId: string;
  try {
    networkId = await ensureSharedNetwork();
  } catch (err) {
    log("ensure", `failed to ensure network: ${err}`);
    return;
  }
  if (!networkId) return;

  // Attach any server that isn't on the network yet.
  const servers = db.getAllServers().filter((s) => s.provider_id);
  for (const server of servers) {
    if (server.private_ipv4) continue;
    try {
      log("attach", `Attaching server ${server.name} (${server.provider_id})`);
      await compute.networks.attachServer(server.provider_id, networkId);
      const privateIp = await compute.networks.getPrivateIpv4(server.provider_id, networkId);
      if (privateIp) {
        db.updateServer(server.id, { private_ipv4: privateIp });
        log("attach", `Server ${server.name} private_ipv4=${privateIp}`);
      } else {
        log("attach", `Server ${server.name} attached but no private IPv4 yet`);
      }
    } catch (err) {
      log("attach", `Failed to attach ${server.name}: ${err}`);
    }
  }

  // Sync /etc/hosts for `<app>.ocd.internal` on every server. Each server
  // runs its own Caddy srv_internal, so app entries point at 127.0.0.1;
  // service entries still point at the service host's private IP. Best-
  // effort — the next tick retries any server that's unreachable now.
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
 *   - `<app>.ocd.internal`      → this server's own private_ipv4 (local Caddy)
 *   - `<svc>.svc.ocd.internal`  → service host's private_ipv4 (direct)
 *
 * Each server runs its own Caddy srv_internal on :8080 with routes for every
 * app, so callers reach the local Caddy and it reverse-proxies to the
 * replica pool over the private network. App entries point at the *server's
 * own* private IP rather than 127.0.0.1 because Docker containers inherit
 * DNS from the host — a 127.0.0.1 entry would loop back to the container
 * itself instead of hitting the host's Caddy. The server's private IP is
 * reachable from both the host and its local containers.
 *
 * Service entries stay as private-IP pointers to the service host because
 * services are single-instance and don't need the local Caddy indirection.
 *
 * Idempotent — the block is delimited by BEGIN/END markers so repeated
 * runs just overwrite the same region.
 */
export async function syncInternalHosts(): Promise<void> {
  const panel = db.getPanel();
  if (!panel) return;

  const apps = db.getAllApps();
  const serviceLines: string[] = [];
  for (const service of db.getAllServices()) {
    const instance = db.getServiceInstancesUnscoped(service.id)[0];
    if (!instance) continue;
    const host = db.getServerUnscoped(instance.server_id);
    if (!host || !host.private_ipv4) continue;
    serviceLines.push(`${host.private_ipv4} ${service.name}.svc.ocd.internal`);
  }

  const servers = db.getAllServers().filter((s) => s.ipv4);
  for (const server of servers) {
    const lines: string[] = [];
    if (server.private_ipv4) {
      for (const app of apps) {
        lines.push(`${server.private_ipv4} ${app.name}.ocd.internal`);
      }
    }
    lines.push(...serviceLines);
    try {
      await writeHostsBlock(server.ipv4, lines.join("\n"), server.ssh_host_key || undefined);
    } catch (err) {
      log("hosts", `Failed to update /etc/hosts on ${server.name}: ${err}`);
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
