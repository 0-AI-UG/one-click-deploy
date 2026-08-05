import { get, post, ApiError } from "../api.ts";
import { newFollowRetryState, resetFollowRetryState, handleTransientFollowError } from "../ops.ts";
import { webConfirm } from "../confirm.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, colorStatus, table } from "../format.ts";

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
  let app = "";
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--app") {
      app = args[++i] || "";
    } else if (arg.startsWith("--app=")) {
      app = arg.slice(6);
    } else if (arg === "--limit") {
      const n = parseInt(args[++i] || "", 10);
      if (!isNaN(n)) limit = n;
    } else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice(8), 10);
      if (!isNaN(n)) limit = n;
    }
  }

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
    console.log(`\n${RED}${BOLD}Error:${RESET} ${RED}${op.error.message}${RESET}`);
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
  let idStr = "";
  let since = 0;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--follow" || arg === "-f") {
      follow = true;
    } else if (arg === "--since") {
      const n = parseInt(args[++i] || "", 10);
      if (!isNaN(n)) since = n;
    } else if (arg.startsWith("--since=")) {
      const n = parseInt(arg.slice(8), 10);
      if (!isNaN(n)) since = n;
    } else if (!arg.startsWith("-") && !idStr) {
      idStr = arg;
    }
  }

  const id = parseInt(idStr, 10);
  if (!idStr || isNaN(id)) {
    console.error("Usage: ocd ops logs <id> [--since N] [--follow]");
    process.exit(1);
  }

  if (!follow) {
    const data = await get<{ status: string; logs: OpLog[] }>(`/api/operations/${id}/logs?since=${since}`);
    for (const log of data.logs) printLog(log);
    return;
  }

  let cursor = since;
  const retry = newFollowRetryState();
  while (true) {
    let data: { status: string; logs: OpLog[]; next_cursor?: number };
    try {
      data = await get<{ status: string; logs: OpLog[]; next_cursor?: number }>(
        `/api/operations/${id}/logs?since=${cursor}&wait=15000`,
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
  const id = parseInt(args[0] || "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    console.error(usageLine);
    process.exit(1);
  }
  return id;
}

async function opsCancel(args: string[]): Promise<void> {
  const id = parseOpId(args, "Usage: ocd ops cancel <id> [--yes]");
  const confirmation = await webConfirm(
    "cancel_operation",
    "operation",
    id,
    { yes: args.includes("--yes") },
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
  const id = parseOpId(args, "Usage: ocd ops finalize <id> [--status auto|done|failed]");
  let status: "auto" | "done" | "failed" = "auto";
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const value = arg === "--status" ? args[++i] : arg.startsWith("--status=") ? arg.slice(9) : "";
    if (value) {
      if (value !== "auto" && value !== "done" && value !== "failed") {
        console.error("--status must be auto, done, or failed");
        process.exit(1);
      }
      status = value;
    }
  }
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
  logs <id> [--follow]       Print an operation's logs (--follow to stream)
  cancel <id> [--yes]        Confirm, then stop and compensate safely
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
