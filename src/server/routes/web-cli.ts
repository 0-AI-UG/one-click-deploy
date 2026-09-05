import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { authenticateRequest, createUiCliToken } from "../lib/auth.ts";
import { PermissionError } from "../lib/errors.ts";
import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { getUserById } from "../../shared/db.ts";
import {
  buildWebCliInvocation,
  findWebCliCommand,
  formatWebCliCommand,
  type WebCliValues,
} from "../../shared/web-cli.ts";

const encoder = new TextEncoder();
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_MS = 15 * 60 * 1000;

type RunBody = {
  command_id?: string;
  values?: WebCliValues;
  confirmed?: boolean;
  confirmation_code?: string;
  workspace?: {
    entry?: string;
    files?: Array<{ path?: string; content?: string }>;
  };
};

const WORKSPACE_COMMANDS = new Set(["app.deploy", "stacks.deploy", "manifest.validate"]);

function prepareWorkspace(configRoot: string, commandId: string, raw: RunBody["workspace"]): string {
  if (!WORKSPACE_COMMANDS.has(commandId)) {
    if (raw !== undefined) throw new Error("This command does not accept workspace files");
    return configRoot;
  }
  if (!raw || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > 25) {
    throw new Error("Deployment workspace must contain 1-25 manifest files");
  }
  const workspaceDir = path.join(configRoot, "workspace");
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const file of raw.files) {
    if (typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Invalid workspace file");
    const filePath = file.path.trim();
    if (
      !filePath || filePath.length > 240 || filePath.startsWith("/") || filePath.includes("\\") ||
      /(^|\/)\.\.?($|\/)/.test(filePath) || /[\u0000-\u001f\u007f]/.test(filePath)
    ) throw new Error("Workspace paths must be safe relative paths");
    if (paths.has(filePath)) throw new Error(`Duplicate workspace path: ${filePath}`);
    paths.add(filePath);
    totalBytes += Buffer.byteLength(file.content);
    if (totalBytes > 1024 * 1024) throw new Error("Deployment workspace exceeds 1 MiB");
    const target = path.join(workspaceDir, filePath);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.content, { mode: 0o600 });
  }
  if (typeof raw.entry !== "string" || !paths.has(raw.entry)) throw new Error("Workspace entry must name an uploaded manifest");
  const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: workspaceDir, stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error("Could not initialize deployment workspace");
  return workspaceDir;
}

async function requireUiActionUser(request: Request) {
  const payload = await authenticateRequest(request);
  if (payload.client) {
    throw new PermissionError("UI actions require a signed-in browser session");
  }
  const user = getUserById(payload.userId);
  if (!user) throw new PermissionError("Unauthorized");
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

export async function handleCliActionRun(request: Request): Promise<Response> {
  try {
    const { payload, user } = await requireUiActionUser(request);

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
    let stdin: string | undefined;
    try {
      const built = buildWebCliInvocation(command, body.values || {});
      argv = built.argv;
      stdin = built.stdin;
      if (WORKSPACE_COMMANDS.has(command.id) && body.workspace?.entry !== body.values?.manifest) {
        throw new Error("Workspace entry must match the manifest path");
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Invalid command parameters" },
        { status: 400, headers: corsHeaders },
      );
    }

    const confirmationCode = typeof body.confirmation_code === "string"
      ? body.confirmation_code.trim()
      : "";
    if (confirmationCode && !/^[0-9a-f-]{36}$/i.test(confirmationCode)) {
      return Response.json({ error: "Invalid confirmation token" }, { status: 400, headers: corsHeaders });
    }

    const token = await createUiCliToken({
      userId: payload.userId,
      username: payload.username,
      v: user.token_version,
    });
    const invocation = cliInvocation(argv);
    console.info(`[cli-action] user=${payload.userId} command=${command.id}`);

    let runningProc: ReturnType<typeof Bun.spawn> | undefined;
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (value: Uint8Array) => {
          if (!streamCancelled) controller.enqueue(value);
        };
        let configRoot: string | undefined;
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
          // Setup can fail before a process exists (for example, an unwritable
          // temp directory). Report it through the same error stream.
          configRoot = mkdtempSync(path.join(tmpdir(), "ocd-ui-action-"));
          const configDir = path.join(configRoot, "ocd");
          mkdirSync(configDir, { recursive: true, mode: 0o700 });
          writeFileSync(
            path.join(configDir, "config.json"),
            `${JSON.stringify({ panel_url: localPanelUrl(), token, username: payload.username })}\n`,
            { mode: 0o600 },
          );
          const cwd = prepareWorkspace(configRoot, command.id, body.workspace);
          enqueue(event("start", { command: formatWebCliCommand(argv) }));
          proc = Bun.spawn(invocation, {
            cwd,
            env: {
              // Never expose the panel process environment to a user-authored
              // manifest (for example through auth.password_env). The CLI only
              // needs its executable search path, locale, temp dir and the
              // isolated config written above.
              PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
              LANG: process.env.LANG || "C.UTF-8",
              TMPDIR: process.env.TMPDIR || tmpdir(),
              XDG_CONFIG_HOME: configRoot,
              ...(confirmationCode ? { OCD_CONFIRMATION_CODE: confirmationCode } : {}),
            },
            stdin: stdin === undefined ? "ignore" : "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          runningProc = proc;
          if (stdin !== undefined) {
            const sink = proc.stdin as unknown as { write(value: string): unknown; end(): unknown };
            sink.write(stdin);
            sink.end();
          }
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
          try {
            if (configRoot) rmSync(configRoot, { recursive: true, force: true });
          } catch (err) {
            console.error("[cli-action] Failed to remove temporary CLI configuration", err);
          } finally {
            if (!streamCancelled) controller.close();
          }
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
    return handleError(err);
  }
}

/** Compatibility export for older callers during rolling upgrades. */
export const handleWebCliRun = handleCliActionRun;
