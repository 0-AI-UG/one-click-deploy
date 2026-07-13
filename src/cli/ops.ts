import { get, post, put, resolveApp, ApiError, type App } from "./api.ts";
import { CYAN, DIM, GREEN, RED, RESET, YELLOW } from "./format.ts";

export interface OperationEventPoll {
  status: "pending" | "running" | "done" | "failed" | "compensating" | "compensated" | "cancelled";
  last_step: string | null;
  error: { message?: string; cancelled?: boolean } | null;
  steps: Array<{
    seq: number;
    step: string;
    phase: "forward" | "compensate";
    status: "started" | "ok" | "skipped" | "failed";
    detail: string;
  }>;
}

export const TERMINAL = new Set(["done", "failed", "cancelled", "compensated"]);

// The op runs server-side regardless of our connection, so a transient gateway
// blip (panel restart/redeploy mid-op) shouldn't abort following it. Retry the
// long-poll a bounded number of times, backing off, before giving up.
const MAX_TRANSIENT_RETRIES = 10;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll an operation until it reaches a terminal state, printing step events
 * as they arrive. Returns ok=true only if the op completed successfully.
 *
 * Resilient to transient gateway/network failures: a 502/503/504 or dropped
 * connection is retried (with backoff) rather than aborting, since the op keeps
 * running server-side. Only a terminal op status or exhausted retries stop us.
 */
export async function followOp(opId: number): Promise<{ ok: boolean; error?: string }> {
  let lastSeq = 0;
  let transientRetries = 0;
  while (true) {
    let poll: OperationEventPoll;
    try {
      poll = await get<OperationEventPoll>(
        `/api/operations/${opId}/events?since=${lastSeq}&wait=15000`,
      );
      transientRetries = 0;
    } catch (err) {
      if (err instanceof ApiError && err.isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        console.log(
          `  ${YELLOW}reconnecting${RESET} ${DIM}(panel unreachable, attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES})${RESET}`,
        );
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      // Give up following, but the op may still be running server-side.
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `lost contact with panel while following op #${opId} (${detail}); it may still be running — check its status`,
      };
    }

    for (const event of poll.steps) {
      if (event.phase === "compensate") {
        const step = `rollback ${event.step}`.padEnd(22);
        console.log(`  ${RED}${step}${RESET} ${event.detail || event.status}`);
      } else {
        const step = event.step.padEnd(22);
        if (event.status === "failed") {
          console.log(`  ${RED}${step}${RESET} ${event.detail}`);
        } else if (event.status === "ok" || event.status === "skipped") {
          console.log(`  ${GREEN}${step}${RESET} ${event.status === "skipped" ? "(skipped) " : ""}${event.detail}`);
        } else {
          console.log(`  ${CYAN}${step}${RESET} ${event.detail || "…"}`);
        }
      }
      lastSeq = event.seq;
    }

    if (TERMINAL.has(poll.status)) {
      if (poll.status === "done") return { ok: true };
      return { ok: false, error: poll.error?.message || poll.status };
    }
  }
}

export interface RunAppOpOptions {
  args: string[];
  /** CLI command name, used for the "Usage: ocd <command> <app>" guard. */
  command: string;
  /** Endpoint suffix appended to /api/apps/:id/, e.g. "restart". */
  endpoint: string;
  /** Verb shown on failure, e.g. "Restart" -> "Restart failed: ...". */
  verb: string;
  /** Past-tense success label, e.g. "Restarted" -> "Restarted <app>". */
  done: string;
  method?: "POST" | "PUT";
  body?: unknown;
  /** Pre-resolved app; skips the guard + resolveApp (e.g. rollback). */
  app?: App;
  /** Optional progress line printed before the request, e.g. "Redeploying". */
  progress?: string;
  /** When true, don't poll the op; just confirm it was queued. */
  queued?: boolean;
}

/**
 * Run a lifecycle operation against an app: resolve the app, POST to its
 * endpoint, and either follow the resulting operation to completion or report
 * that it was queued.
 */
export async function runAppOp(opts: RunAppOpOptions): Promise<void> {
  let app = opts.app;
  if (!app) {
    const appName = opts.args[0];
    if (!appName) {
      console.error(`Usage: ocd ${opts.command} <app>`);
      process.exit(1);
    }
    app = await resolveApp(appName);
  }

  if (opts.progress) {
    console.log(`${opts.progress} ${app.name}...`);
  }

  const endpoint = `/api/apps/${app.id}/${opts.endpoint}`;
  const send = opts.method === "PUT" ? put : post;

  if (opts.queued) {
    try {
      const result = await send<{ ok: boolean; op_id?: number; error?: string }>(endpoint, opts.body);
      if (result.ok) {
        console.log(`${GREEN}${opts.verb} queued for ${app.name}${RESET}`);
      } else {
        console.error(`\n${RED}${opts.verb} failed: ${result.error || "unknown error"}${RESET}`);
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`\n${RED}${opts.verb} failed: ${err.message}${RESET}`);
      process.exit(1);
    }
    return;
  }

  const { op_id } = await send<{ op_id: number }>(endpoint, opts.body);
  const result = await followOp(op_id);

  if (result.ok) {
    console.log(`${GREEN}${opts.done} ${app.name}${RESET}`);
  } else {
    console.error(`${RED}${opts.verb} failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
