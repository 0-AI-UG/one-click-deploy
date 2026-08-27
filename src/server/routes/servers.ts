import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { enrichAppForResponse } from "./apps.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { getOrCreateLocalKeyPair, sshExec } from "../../shared/remote/index.ts";

/** Scrub each server's app rows through enrichAppForResponse so secrets never
 *  leak from the server-overview endpoints (same guarantee as /api/apps). */
function scrubServersWithApps(servers: any[]): any[] {
  return servers.map((s) => ({ ...s, apps: (s.apps || []).map((a: any) => enrichAppForResponse(a)) }));
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteServer(request: Request, serverId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "servers.delete");
    if (!db.getServer(serverId)) {
      return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "delete_server", "server", String(serverId));
    const apps = db.getApps(serverId);
    const services = db.getServicesOnServer(serverId);
    const keys = [
      `server:${serverId}`,
      ...apps.map((a) => `app:${a.id}`),
      ...services.map((s) => `service:${s.id}`),
    ];
    const { opId } = enqueue({
      kind: "destroy_server",
      resourceKeys: keys,
      input: { serverId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** PATCH /api/servers/:id/pool — move a server into a named capacity pool.
 *  Governs FUTURE placement only (next deploy/scale/converge); replicas already
 *  running on the server stay put — no active migration here. */
export async function handleSetServerPool(request: Request, serverId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.manage");
    const body = (await request.json().catch(() => ({}))) as { pool?: unknown };
    const pool = body.pool;

    const server = db.getServer(serverId);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { status: 404, headers: corsHeaders });

    if (typeof pool !== "string" || pool.length > 32 || !/^[a-z][a-z0-9-]*$/.test(pool)) {
      return Response.json(
        { ok: false, error: "pool must be a lowercase slug (letters, digits, hyphens; e.g. general or staging)" },
        { status: 400, headers: corsHeaders },
      );
    }

    db.updateServerPool(serverId, pool);
    return Response.json({ ok: true, pool }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRefreshServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServerEnrollmentKey(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.create");
    const { publicKey } = await getOrCreateLocalKeyPair();
    return Response.json({ public_key: publicKey }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

type ConnectServerBody = {
  name?: unknown;
  management_address?: unknown;
  private_ipv4?: unknown;
  ssh_host_key?: unknown;
  ssh_user?: unknown;
  ssh_port?: unknown;
  pool?: unknown;
};

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isPrivateIpv4(value: string): boolean {
  if (!isIpv4(value)) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isPinnedEd25519HostKey(address: string, hostKey: string): boolean {
  if (hostKey.includes("\n") || hostKey.includes("\r")) return false;
  const [host, keyType, keyData, ...extra] = hostKey.trim().split(/\s+/);
  return host === address && keyType === "ssh-ed25519" && extra.length === 0 &&
    typeof keyData === "string" && keyData.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(keyData);
}

/** Connect an operator-owned stateless Docker host. The operator first
 * installs OCD's enrollment key and supplies a separately verified host key;
 * OCD deliberately never trusts a first-seen key for external machines. */
export async function handleConnectServer(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.create");
    const body = await request.json() as ConnectServerBody;
    const name = String(body.name ?? "").trim();
    const address = String(body.management_address ?? "").trim();
    const privateIpv4 = String(body.private_ipv4 ?? "").trim();
    const hostKey = String(body.ssh_host_key ?? "").trim();
    const sshUser = String(body.ssh_user ?? "root").trim();
    const sshPort = Number(body.ssh_port ?? 22);
    const pool = String(body.pool ?? "general").trim();

    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      return Response.json({ error: "name must be a lowercase server slug" }, { status: 400, headers: corsHeaders });
    }
    // Runtime helpers still use the IPv4 field and root:22. Persist explicit
    // SSH metadata now, but fail closed until every runtime path supports more.
    if (!isIpv4(address)) {
      return Response.json({ error: "management_address must currently be an IPv4 address" }, { status: 400, headers: corsHeaders });
    }
    if (!isPrivateIpv4(privateIpv4)) {
      return Response.json({ error: "private_ipv4 must be an RFC1918 IPv4 address present on the host" }, { status: 400, headers: corsHeaders });
    }
    if (sshUser !== "root" || sshPort !== 22) {
      return Response.json({ error: "connected hosts currently require ssh_user=root and ssh_port=22" }, { status: 400, headers: corsHeaders });
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(pool)) {
      return Response.json({ error: "pool must be a lowercase slug" }, { status: 400, headers: corsHeaders });
    }
    const expectedHostPrefix = `${address} ssh-ed25519 `;
    if (!isPinnedEd25519HostKey(address, hostKey)) {
      return Response.json(
        { error: `ssh_host_key must be the verified full ssh-keyscan line beginning with '${expectedHostPrefix}'` },
        { status: 400, headers: corsHeaders },
      );
    }
    if (db.getServers().some((server) => server.name === name || server.management_address === address || server.ipv4 === address)) {
      return Response.json({ error: "A server with this name or management address is already connected" }, { status: 409, headers: corsHeaders });
    }

    const probe = await sshExec(
      address,
      "docker info --format '{{.ServerVersion}}' && hostname -I",
      hostKey,
      { user: sshUser, port: sshPort },
    );
    if (probe.exitCode !== 0) {
      return Response.json(
        { error: "SSH key authentication or Docker preflight failed; install the enrollment key and ensure Docker is running" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (!probe.stdout.split(/\s+/).includes(privateIpv4)) {
      return Response.json(
        { error: `Host does not report private address ${privateIpv4}; refusing an unreachable fleet route` },
        { status: 400, headers: corsHeaders },
      );
    }
    // Re-bind the independently verified key material to the private address,
    // then prove the panel itself can reach that route without TOFU.
    const [, keyType, keyData] = hostKey.split(/\s+/);
    const privateHostKey = `${privateIpv4} ${keyType} ${keyData}`;
    const privateProbe = await sshExec(
      privateIpv4,
      "true",
      privateHostKey,
      { user: sshUser, port: sshPort },
    );
    if (privateProbe.exitCode !== 0) {
      return Response.json(
        { error: `Panel cannot reach ${privateIpv4} over the verified private SSH route` },
        { status: 400, headers: corsHeaders },
      );
    }

    const server = db.insertServer({
      name,
      provider_id: "",
      provider: "external",
      ownership: "connected",
      ipv4: address,
      ipv6: "",
      private_ipv4: privateIpv4,
      management_address: address,
      ssh_user: sshUser,
      ssh_port: sshPort,
      type: "external",
      location: "external",
      status: "ready",
      pool,
    });
    db.updateServerHostKey(server.id, hostKey);
    return Response.json({ server: db.getServer(server.id) }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
