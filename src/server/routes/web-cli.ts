import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { authenticateRequest, createWebCliToken } from "../lib/auth.ts";
import { PermissionError } from "../lib/errors.ts";
import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { getUserById, hasPermission } from "../../shared/db.ts";
import {
  buildWebCliArgv,
  findWebCliCommand,
  formatWebCliCommand,
  type WebCliValues,
} from "../../shared/web-cli.ts";

const encoder = new TextEncoder();
const activeByUser = new Set<string>();
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_MS = 15 * 60 * 1000;

type RunBody = {
  command_id?: string;
  values?: WebCliValues;
  confirmed?: boolean;
};

async function requireWebCliUser(request: Request) {
  const payload = await authenticateRequest(request);
  if (payload.client === "cli") {
    throw new PermissionError("The web CLI requires a signed-in browser session");
  }
  const user = getUserById(payload.userId);
  if (!user) throw new PermissionError("Unauthorized");
  if (!user.is_admin && !hasPermission(payload.userId, "cli.access")) {
    throw new PermissionError("CLI access is not enabled for this account");
  }
  return { payload, user };
}

function localPanelUrl(): string {
  if (process.env.OCD_WEB_CLI_PANEL_URL) return process.env.OCD_WEB_CLI_PANEL_URL;
  return `http://127.0.0.1:${process.env.PORT || "3001"}`;
}

function cliInvocation(argv: string[]): string[] {
  const override = process.env.OCD_WEB_CLI_BINARY;
  if (override) return [override, ...argv];

  const binary = path.resolve(
    import.meta.dir,
    `../../../dist/cli/ocd-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (existsSync(binary)) return [binary, ...argv];

  // Development and source-test path: this is the same CLI entrypoint that is
  // compiled into the downloadable production binary.
  return [process.execPath, "run", path.resolve(import.meta.dir, "../../cli/main.ts"), ...argv];
}

function event(type: string, data: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(`${JSON.stringify({ type, ...data })}\n`);
}

export async function handleWebCliRun(request: Request): Promise<Response> {
  let userId = "";
  try {
    const { payload, user } = await requireWebCliUser(request);
    userId = payload.userId;
    if (activeByUser.has(userId)) {
      return Response.json(
        { error: "One CLI command is already running for this user" },
        { status: 409, headers: corsHeaders },
      );
    }

    const body = await request.json() as RunBody;
    const command = typeof body.command_id === "string" ? findWebCliCommand(body.command_id) : undefined;
    if (!command) {
      return Response.json({ error: "Unknown CLI command" }, { status: 400, headers: corsHeaders });
    }
    if (command.unavailableReason) {
      return Response.json({ error: command.unavailableReason }, { status: 400, headers: corsHeaders });
    }
    if (command.danger && body.confirmed !== true) {
      return Response.json(
        { error: "Review and confirm this command before running it" },
        { status: 400, headers: corsHeaders },
      );
    }

    let argv: string[];
    try {
      argv = buildWebCliArgv(command, body.values || {});
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Invalid command parameters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const token = await createWebCliToken({
      userId: payload.userId,
      username: payload.username,
      v: user.token_version,
    });
    const invocation = cliInvocation(argv);
    activeByUser.add(userId);
    console.info(`[web-cli] user=${payload.userId} command=${command.id}`);

    let runningProc: ReturnType<typeof Bun.spawn> | undefined;
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (value: Uint8Array) => {
          if (!streamCancelled) controller.enqueue(value);
        };
        const configRoot = mkdtempSync(path.join(tmpdir(), "ocd-web-cli-"));
        const configDir = path.join(configRoot, "ocd");
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          path.join(configDir, "config.json"),
          `${JSON.stringify({ panel_url: localPanelUrl(), token, username: payload.username })}\n`,
          { mode: 0o600 },
        );

        let proc: ReturnType<typeof Bun.spawn> | undefined;
        let outputBytes = 0;
        let timedOut = false;
        let truncated = false;
        const startedAt = Date.now();
        const abort = () => proc?.kill();
        request.signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => {
          timedOut = true;
          proc?.kill();
        }, MAX_RUNTIME_MS);

        const emitOutput = (channel: "stdout" | "stderr", chunk: Uint8Array) => {
          if (truncated) return;
          const remaining = MAX_OUTPUT_BYTES - outputBytes;
          if (remaining <= 0) {
            truncated = true;
            enqueue(event("stderr", { data: "\n[output truncated at 2 MiB]\n" }));
            proc?.kill();
            return;
          }
          const accepted = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
          outputBytes += accepted.byteLength;
          enqueue(event(channel, { data: new TextDecoder().decode(accepted) }));
          if (accepted.byteLength < chunk.byteLength) {
            truncated = true;
            enqueue(event("stderr", { data: "\n[output truncated at 2 MiB]\n" }));
            proc?.kill();
          }
        };

        try {
          enqueue(event("start", { command: formatWebCliCommand(argv) }));
          proc = Bun.spawn(invocation, {
            cwd: configRoot,
            env: { ...process.env, XDG_CONFIG_HOME: configRoot },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          runningProc = proc;
          const stdout = proc.stdout as ReadableStream<Uint8Array>;
          const stderr = proc.stderr as ReadableStream<Uint8Array>;
          const pump = async (source: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
            const reader = source.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) return;
                emitOutput(channel, value);
              }
            } finally {
              reader.releaseLock();
            }
          };
          await Promise.all([
            pump(stdout, "stdout"),
            pump(stderr, "stderr"),
          ]);
          const exitCode = await proc.exited;
          enqueue(event("exit", {
            code: exitCode,
            timed_out: timedOut,
            truncated,
            duration_ms: Date.now() - startedAt,
          }));
        } catch (err) {
          if (!streamCancelled) {
            enqueue(event("error", {
              error: err instanceof Error ? err.message : "Failed to run CLI command",
            }));
          }
        } finally {
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", abort);
          activeByUser.delete(payload.userId);
          rmSync(configRoot, { recursive: true, force: true });
          if (!streamCancelled) controller.close();
        }
      },
      cancel() {
        streamCancelled = true;
        runningProc?.kill();
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (userId) activeByUser.delete(userId);
    return handleError(err);
  }
}
