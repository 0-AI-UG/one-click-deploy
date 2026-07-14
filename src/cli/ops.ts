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
// blip (panel restart/redeploy mid-op, which can 502 for minutes) shouldn't
// abort following it. Instead of a small fixed retry count, ride out a
// *continuous* outage up to a generous time budget, backing off between polls.
const FOLLOW_OUTAGE_BUDGET_MS = 30 * 60 * 1000; // ~30 min of continuous unreachability
const RETRY_BACKOFF_START_MS = 3000;
const RETRY_BACKOFF_MAX_MS = 15000;
const RETRY_BACKOFF_FACTOR = 1.5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mutable state tracking a run of continuous unreachability while following an
 *  op. `outageStartedAt === 0` means "not currently in an outage". */
export interface FollowRetryState {
  outageStartedAt: number;
  backoffMs: number;
}

export function newFollowRetryState(): FollowRetryState {
  return { outageStartedAt: 0, backoffMs: RETRY_BACKOFF_START_MS };
}

/**
 * Handle a transient poll failure while following an op. Since the op keeps
 * running server-side, we keep retrying until ~30 min of *continuous*
 * unreachability elapses. Returns false when that budget is exhausted (caller
 * should give up); otherwise emits an informative reconnecting line via `log`,
 * sleeps with capped exponential backoff, and returns true to retry.
 *
 * `state` must be reset (via newFollowRetryState / resetFollowRetryState) after
 * any successful poll so the budget measures continuous — not cumulative —
 * outage time.
 */
export async function handleTransientFollowError(
  state: FollowRetryState,
  log: (line: string) => void,
): Promise<boolean> {
  const now = Date.now();
  if (state.outageStartedAt === 0) state.outageStartedAt = now;
  const elapsedMs = now - state.outageStartedAt;
  if (elapsedMs >= FOLLOW_OUTAGE_BUDGET_MS) return false;

  const elapsedSec = Math.round(elapsedMs / 1000);
  const budgetMin = Math.round(FOLLOW_OUTAGE_BUDGET_MS / 60_000);
  log(
    `${YELLOW}reconnecting${RESET} ${DIM}(panel unreachable ${elapsedSec}s; will keep trying up to ~${budgetMin} min)${RESET}`,
  );

  await sleep(state.backoffMs);
  state.backoffMs = Math.min(Math.round(state.backoffMs * RETRY_BACKOFF_FACTOR), RETRY_BACKOFF_MAX_MS);
  return true;
}

/** Reset outage tracking + backoff after a successful poll. */
export function resetFollowRetryState(state: FollowRetryState): void {
  state.outageStartedAt = 0;
  state.backoffMs = RETRY_BACKOFF_START_MS;
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
  const retry = newFollowRetryState();
  while (true) {
    let poll: OperationEventPoll;
    try {
      poll = await get<OperationEventPoll>(
        `/api/operations/${opId}/events?since=${lastSeq}&wait=15000`,
      );
      resetFollowRetryState(retry);
    } catch (err) {
      if (err instanceof ApiError && err.isTransient) {
        if (await handleTransientFollowError(retry, (line) => console.log(`  ${line}`))) continue;
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
