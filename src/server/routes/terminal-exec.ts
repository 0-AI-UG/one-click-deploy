import * as db from "../../shared/db.ts";
import { getOrgsForUser } from "../../shared/db/orgs.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { authenticateRequest } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [terminal-exec:${context}]`, ...args);
}

const MAX_COMMAND_BYTES = 256 * 1024;

type TargetKind = "server" | "replica" | "service-instance";

function parseTarget(raw: unknown): { kind: TargetKind; id: number } | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(server|replica|service-instance):(\d+)$/);
  if (!m) return null;
  return { kind: m[1] as TargetKind, id: parseInt(m[2], 10) };
}

function resolveTarget(
  kind: TargetKind,
  id: number,
  userOrgIds: Set<string>,
): { ip: string; hostKey?: string; container?: string } | { error: string } {
  if (kind === "server") {
    const srv = db.getServerUnscoped(id);
    if (!srv) return { error: "server not found" };
    if (!userOrgIds.has(srv.org_id)) return { error: "server not found" };
    return { ip: srv.ipv4, hostKey: srv.ssh_host_key || undefined };
  }
  if (kind === "replica") {
    const replica = db.getReplicaUnscoped(id);
    if (!replica) return { error: "replica not found" };
    const app = db.getAppUnscoped(replica.app_id);
    if (!app || !userOrgIds.has(app.org_id)) return { error: "replica not found" };
    const srv = db.getServerUnscoped(replica.server_id);
    if (!srv) return { error: "replica's server not found" };
    return { ip: srv.ipv4, hostKey: srv.ssh_host_key || undefined, container: replica.container_name };
  }
  const instance = db.getServiceInstance(id);
  if (!instance) return { error: "service instance not found" };
  const service = db.getServiceUnscoped(instance.service_id);
  if (!service || !userOrgIds.has(service.org_id)) return { error: "service instance not found" };
  const srv = db.getServerUnscoped(instance.server_id);
  if (!srv) return { error: "service instance's server not found" };
  return { ip: srv.ipv4, hostKey: srv.ssh_host_key || undefined, container: instance.container_name };
}

function buildRemoteCommand(userCommand: string, container: string | undefined): string {
  // Base64 the user command so no quoting/escaping is needed remotely, then
  // pipe the decoded script into sh. For container targets, pipe through
  // `docker exec -i` (no TTY) as the deploy user.
  const b64 = Buffer.from(userCommand, "utf8").toString("base64");
  if (container) {
    // Container name is stored in our DB — still, interpolate via single quotes
    // for defense in depth (the quote char itself is not a valid container name char).
    return `echo ${b64} | base64 -d | su deploy -c 'docker exec -i ${container} sh'`;
  }
  return `echo ${b64} | base64 -d | sh`;
}

export async function handleTerminalExec(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    throw err;
  }

  if (!db.hasPermission(auth.userId, "terminal.access")) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { target?: unknown; command?: unknown } | null;
  if (!body) return Response.json({ error: "invalid JSON" }, { status: 400 });

  const target = parseTarget(body.target);
  if (!target) return Response.json({ error: "bad target" }, { status: 400 });

  if (typeof body.command !== "string" || body.command.length === 0) {
    return Response.json({ error: "command required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.command, "utf8") > MAX_COMMAND_BYTES) {
    return Response.json({ error: "command too large" }, { status: 413 });
  }

  const userOrgIds = new Set(getOrgsForUser(auth.userId).map((o) => o.id));
  const resolved = resolveTarget(target.kind, target.id, userOrgIds);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: 404 });

  log("exec", `user=${auth.userId} target=${target.kind}:${target.id} ip=${resolved.ip} bytes=${body.command.length}`);

  const remoteCommand = buildRemoteCommand(body.command, resolved.container);
  const result = await sshExec(resolved.ip, remoteCommand, resolved.hostKey);

  return Response.json({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}
