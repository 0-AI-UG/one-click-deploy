import { unlinkSync } from "node:fs";
import * as db from "../../shared/db.ts";
import { buildSshArgs, sshExec } from "../../engine/hetzner/ssh.ts";
import { authenticateRequest } from "../lib/auth.ts";
import { AuthError } from "../lib/errors.ts";
import { appScope } from "../lib/permissions.ts";
import { buildRemoteCommand, parseTarget, resolveTerminalTarget } from "./terminal-exec.ts";

const MAX_PATH_BYTES = 16 * 1024;

export function fileReadScript(filePath: string): string {
  const encoded = Buffer.from(filePath, "utf8").toString("base64");
  return `path=$(printf %s ${encoded} | base64 -d); exec cat -- "$path"`;
}

function fileSizeScript(filePath: string): string {
  const encoded = Buffer.from(filePath, "utf8").toString("base64");
  return `path=$(printf %s ${encoded} | base64 -d); test -f "$path" && test -r "$path" && stat -c %s -- "$path"`;
}

export async function handleTerminalFile(request: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateRequest(request);
  } catch (error) {
    if (error instanceof AuthError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    throw error;
  }
  const user = db.getUserById(auth.userId);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null) as { target?: unknown; path?: unknown } | null;
  const target = parseTarget(body?.target);
  if (!target) return Response.json({ error: "bad target" }, { status: 400 });
  if (typeof body?.path !== "string" || !body.path.startsWith("/") || body.path.includes("\0")) {
    return Response.json({ error: "an absolute file path is required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.path, "utf8") > MAX_PATH_BYTES) {
    return Response.json({ error: "path too large" }, { status: 413 });
  }
  const resolved = resolveTerminalTarget(target.kind, target.id);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: 404 });
  if (!user.is_admin) {
    const permission = resolved.container ? "terminal.container" : "terminal.host";
    const scope = resolved.appId == null ? undefined : appScope(resolved.appId);
    if (!db.hasPermission(auth.userId, permission, scope)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const sizeResult = await sshExec(
    resolved.ip,
    buildRemoteCommand(fileSizeScript(body.path), resolved.container),
    resolved.hostKey,
  );
  const size = Number(sizeResult.stdout.trim());
  if (sizeResult.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0) {
    return Response.json({ error: "file not found or not readable" }, { status: 404 });
  }

  const command = buildRemoteCommand(fileReadScript(body.path), resolved.container);
  const { args, tmpKnownHostsPath } = buildSshArgs({
    ip: resolved.ip,
    command,
    hostKey: resolved.hostKey,
    interactive: false,
  });
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  void new Response(process.stderr).text().then((stderr) => {
    if (stderr.trim()) console.error(`[terminal-file] ${target.kind}:${target.id}: ${stderr.trim().slice(0, 500)}`);
  });
  void process.exited.finally(() => {
    if (tmpKnownHostsPath) {
      try { unlinkSync(tmpKnownHostsPath); } catch { /* already cleaned */ }
    }
  });

  return new Response(process.stdout, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-OCD-File-Size": String(size),
      "Cache-Control": "no-store",
    },
  });
}
