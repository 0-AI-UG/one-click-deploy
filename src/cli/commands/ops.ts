import { get, post, ApiError } from "../api.ts";
import { newFollowRetryState, resetFollowRetryState, handleTransientFollowError, summarizeOperationError } from "../ops.ts";
import { webConfirm } from "../confirm.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, colorStatus, table } from "../format.ts";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";
import { operationLogQuery, parseLogArgs } from "../log-filters.ts";
import { expectArray, expectRecord } from "../response.ts";

interface Op {
  id: number;
  kind: string;
  label: string;
  resource_keys: string[];
  resource_labels: string[];
  input: unknown;
  status: string;
  parent_id: number | null;
  attempt: number;
  scheduled_for: string | null;
  last_step: string | null;
  trigger: string | null;
  triggered_by: number | null;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: { message?: string; cancelled?: boolean } | null;
  total_steps: number;
}

interface Step {
  seq: number;
  step: string;
  phase: "forward" | "compensate";
  status: "started" | "ok" | "skipped" | "failed";
  detail: string;
  output: unknown;
  started_at: string | null;
  finished_at: string | null;
}

interface OpDetail extends Op {
  steps: Step[];
  children: Op[];
}

interface OpsList {
  running: Op[];
  pending: Op[];
  recent: Op[];
  engine: {
    heartbeat: string | null;
    concurrency: number;
    known_kinds?: Array<{ kind: string; label: string; steps: number }>;
  };
}

interface OpLog {
  id: number;
  ts: string;
  level: string;
  message: string;
  attempt: number;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "compensated", "compensation_failed"]);

function fmtTime(ts: string | null | undefined): string {
  return ts ? ts.replace("T", " ").slice(0, 16) : "-";
}

/** Color an operation status: green terminal-success, red failure, cyan
 *  in-flight, dim pending. Distinct from format.ts colorStatus (which is tuned
 *  for app lifecycle states). */
function colorOpStatus(status: string): string {
  switch (status) {
    case "done":
      return `${GREEN}${status}${RESET}`;
    case "running":
    case "compensating":
      return `${CYAN}${status}${RESET}`;
    case "failed":
    case "compensation_failed":
      return `${RED}${status}${RESET}`;
    case "compensated":
    case "cancelled":
      return `${YELLOW}${status}${RESET}`;
    case "pending":
      return `${DIM}${status}${RESET}`;
    default:
      return status;
  }
}

function targetOf(op: Op): string {
  const labels = (op.resource_labels || []).filter(Boolean);
  if (labels.length) return labels.join(", ");
  return (op.resource_keys || []).join(", ") || "-";
}

/** Merge running + pending + recent into one list, deduped by id, with in-flight
 *  ops first (running, then pending) followed by recent (already newest-first). */
function mergeOps(data: OpsList): Op[] {
  const seen = new Set<number>();
  const out: Op[] = [];
  for (const op of [...(data.running || []), ...(data.pending || []), ...(data.recent || [])]) {
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    out.push(op);
  }
  return out;
}

function opMatchesApp(op: Op, needle: string): boolean {
  const hay = [...(op.resource_labels || []), ...(op.resource_keys || [])];
  return hay.some((h) => h.toLowerCase().includes(needle));
}

async function opsList(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    app: { type: "string" }, limit: { type: "string" },
  }, { maxPositionals: 0 });
  const app = (parsed.flags.app as string | undefined) ?? "";
  const limit = positiveIntegerFlag(parsed.flags.limit, "limit", { defaultValue: 20, max: 1000 })!;

  const data = await get<OpsList>("/api/operations");
  console.log(
    `${DIM}Engine:${RESET} heartbeat ${data.engine?.heartbeat ? fmtTime(data.engine.heartbeat) : "none"}, ` +
    `concurrency ${data.engine?.concurrency ?? "-"}`,
  );
  let ops = mergeOps(data);
  if (app) {
    const needle = app.toLowerCase();
    ops = ops.filter((op) => opMatchesApp(op, needle));
  }
  ops = ops.slice(0, limit);

  table(
    ["ID", "KIND", "STATUS", "TARGET", "STARTED", "FINISHED"],
    ops.map((op) => [
      String(op.id),
      op.label,
      colorOpStatus(op.status),
      targetOf(op),
      fmtTime(op.started_at || op.enqueued_at),
      fmtTime(op.finished_at),
    ]),
  );

  if (ops.length > 0) {
    console.log(`\n${DIM}Details: ocd ops <id>  ·  Logs: ocd ops logs <id>${RESET}`);
  }
}

async function opsEngine(): Promise<void> {
  const { engine } = await get<OpsList>("/api/operations");
  console.log(`${BOLD}Operation engine${RESET}`);
  console.log(`${DIM}Heartbeat:${RESET} ${engine.heartbeat ? fmtTime(engine.heartbeat) : "none"}`);
  console.log(`${DIM}Concurrency:${RESET} ${engine.concurrency ?? "-"}`);
  if (engine.known_kinds?.length) {
    table(
      ["KIND", "LABEL", "STEPS"],
      engine.known_kinds.map((kind) => [kind.kind, kind.label, String(kind.steps)]),
    );
  }
}

async function opsShow(id: number): Promise<void> {
  const op = await get<OpDetail>(`/api/operations/${id}`);

  console.log(`${BOLD}#${op.id}${RESET} ${op.label} ${colorOpStatus(op.status)}${op.attempt > 1 ? ` ${DIM}(attempt ${op.attempt})${RESET}` : ""}`);
  const target = targetOf(op);
  if (target && target !== "-") console.log(`${DIM}Target:${RESET}   ${target}`);
  console.log(`${DIM}Started:${RESET}  ${fmtTime(op.started_at || op.enqueued_at)}`);
  if (op.finished_at) console.log(`${DIM}Finished:${RESET} ${fmtTime(op.finished_at)}`);
  if (op.trigger) console.log(`${DIM}Trigger:${RESET}  ${op.trigger}`);

  if (op.error && op.error.message) {
    console.log(`\n${RED}${BOLD}Error:${RESET} ${RED}${summarizeOperationError(op.error.message)}${RESET}`);
    console.log(`${DIM}More context: ocd ops logs ${op.id} --tail=80${RESET}`);
  }

  const commitStep = [...(op.steps || [])]
    .reverse()
    .find((step) => {
      const out = step.output as { gitCommit?: unknown } | null;
      return typeof out?.gitCommit === "string";
    });
  const deployedCommit = (commitStep?.output as { gitCommit?: string } | null)?.gitCommit;
  if (deployedCommit) console.log(`${DIM}Commit:${RESET}   ${deployedCommit}`);

  if (op.steps && op.steps.length > 0) {
    console.log();
    for (const step of op.steps) {
      if (step.phase === "compensate") {
        const label = `rollback ${step.step}`.padEnd(24);
        console.log(`  ${RED}${label}${RESET} ${step.detail || step.status}`);
      } else {
        const label = step.step.padEnd(24);
        if (step.status === "failed") {
          console.log(`  ${RED}${label}${RESET} ${step.detail}`);
        } else if (step.status === "ok" || step.status === "skipped") {
          console.log(`  ${GREEN}${label}${RESET} ${step.status === "skipped" ? "(skipped) " : ""}${step.detail}`);
        } else {
          console.log(`  ${CYAN}${label}${RESET} ${step.detail || "…"}`);
        }
      }
    }
  }

  if (op.children && op.children.length > 0) {
    console.log(`\n${BOLD}Children${RESET}`);
    table(
      ["ID", "KIND", "STATUS", "TARGET"],
      op.children.map((c) => [String(c.id), c.label, colorOpStatus(c.status), targetOf(c)]),
    );
  }
}

function printLog(log: OpLog): void {
  const ts = (log.ts || "").replace("T", " ").slice(0, 19);
  console.log(`${DIM}${ts}${RESET} ${log.level} ${DIM}[attempt ${log.attempt || 1}]${RESET} ${log.message}`);
}

async function opsLogs(args: string[]): Promise<void> {
  const filters = parseLogArgs(args);
  const id = parseInt(filters.target, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== filters.target) {
    console.error("Usage: ocd ops logs <id> [--since TIME|CURSOR] [--tail N] [--child NAME|ID] [--phase STEP] [--follow]");
    process.exit(1);
  }

  if (!filters.follow) {
    const payload = await get<unknown>(`/api/operations/${id}/logs?${operationLogQuery(filters)}`);
    const data = expectRecord(payload, "Operation logs request");
    const logs = expectArray(data.logs, "Operation logs request") as OpLog[];
    for (const log of logs) printLog(log);
    if (logs.length === 0) console.log(`${DIM}(no operation logs matched)${RESET}`);
    return;
  }

  let cursor = filters.cursor;
  if (filters.tail > 0) {
    const initial = await get<{ logs: OpLog[]; next_cursor?: number }>(
      `/api/operations/${id}/logs?${operationLogQuery(filters)}`,
    );
    for (const log of initial.logs) {
      printLog(log);
      cursor = Math.max(cursor, log.id);
    }
    if (typeof initial.next_cursor === "number") cursor = Math.max(cursor, initial.next_cursor);
  }
  const retry = newFollowRetryState();
  while (true) {
    let data: { status: string; logs: OpLog[]; next_cursor?: number };
    try {
      data = await get<{ status: string; logs: OpLog[]; next_cursor?: number }>(
        `/api/operations/${id}/logs?${operationLogQuery({ ...filters, cursor, tail: 0, wait: 15000 })}`,
      );
      resetFollowRetryState(retry);
    } catch (err) {
      if (err instanceof ApiError && err.isTransient) {
        if (await handleTransientFollowError(retry, (line) => console.log(line))) continue;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`${RED}Operation log stream for #${id} remained unavailable (${detail})${RESET}`);
      process.exit(1);
    }

    for (const log of data.logs) {
      printLog(log);
      if (log.id > cursor) cursor = log.id;
    }
    if (typeof data.next_cursor === "number") cursor = Math.max(cursor, data.next_cursor);

    if (TERMINAL.has(data.status)) {
      console.log(`\n${colorOpStatus(data.status)}`);
      return;
    }
  }
}

function parseOpId(args: string[], usageLine: string): number {
  const parsed = parseCliArgs(args, {}, { maxPositionals: 1 });
  const raw = parsed.positionals[0] || "";
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== raw) {
    console.error(usageLine);
    process.exit(1);
  }
  return id;
}

async function opsCancel(args: string[]): Promise<void> {
  if (args.includes("--yes") || args.includes("-y")) {
    throw new Error("--yes has been removed; approve cancellation in the web UI");
  }
  const id = parseOpId(args, "Usage: ocd ops cancel <id>");
  const confirmation = await webConfirm(
    "cancel_operation",
    "operation",
    id,
  );
  if (!confirmation) return;
  await post(
    `/api/operations/${id}/cancel`,
    undefined,
    { "X-OCD-Confirmation": confirmation },
  );
  console.log(`${YELLOW}Cancellation requested for operation #${id}.${RESET}`);
}

async function opsRetry(args: string[]): Promise<void> {
  const id = parseOpId(args, "Usage: ocd ops retry <id>");
  const result = await post<{ op_id: number; resumed: boolean }>(`/api/operations/${id}/retry`);
  console.log(
    `${GREEN}${result.resumed ? "Resumed" : "Retried"} operation as #${result.op_id}.${RESET} ` +
      `${DIM}Follow: ocd ops logs ${result.op_id} --follow${RESET}`,
  );
}

async function opsFinalize(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, { status: { type: "string" } }, { maxPositionals: 1 });
  const rawId = parsed.positionals[0] || "";
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Usage: ocd ops finalize <id> [--status auto|done|failed]");
  const value = (parsed.flags.status as string | undefined) ?? "auto";
  if (value !== "auto" && value !== "done" && value !== "failed") {
    throw new Error("--status must be auto, done, or failed");
  }
  const status: "auto" | "done" | "failed" = value;
  const result = await post<{ status: string; assessment: string }>(
    `/api/operations/${id}/finalize`,
    { status },
  );
  console.log(`${GREEN}Operation #${id} finalized as ${result.status}.${RESET}`);
  console.log(`${DIM}${result.assessment}${RESET}`);
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd ops [--app <name>] [--limit N]

${BOLD}Subcommands:${RESET}
  (list)                     List deploy engine operations (default)
  engine                     Show heartbeat, concurrency and operation kinds
  <id>                       Show an operation's steps and children
  logs <id> [--tail N] [--since TIME] [--child X] [--phase X] [--follow]
  cancel <id>                Confirm in the web UI, then stop and compensate safely
  retry <id>                 Resume cleanup or create a fresh retry
  finalize <id>              Reconcile resources and close a stale operation`);
}

export async function ops(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "logs":
      await opsLogs(args.slice(1));
      return;
    case "list":
      await opsList(args.slice(1));
      return;
    case "engine":
    case "health":
      await opsEngine();
      return;
    case "cancel":
      await opsCancel(args.slice(1));
      return;
    case "retry":
      await opsRetry(args.slice(1));
      return;
    case "finalize":
      await opsFinalize(args.slice(1));
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
  }

  // `ocd ops <id>` — a bare numeric first arg is a detail lookup.
  if (sub !== undefined && !sub.startsWith("-")) {
    const id = parseInt(sub, 10);
    if (!isNaN(id) && String(id) === sub) {
      await opsShow(id);
      return;
    }
  }

  // No subcommand (or flags only) → list.
  await opsList(args);
}
