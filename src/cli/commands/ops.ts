import { get, ApiError } from "../api.ts";
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
  engine: unknown;
}

interface OpLog {
  id: number;
  ts: string;
  level: string;
  message: string;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "compensated", "compensation_failed"]);

const MAX_TRANSIENT_RETRIES = 10;
const RETRY_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  console.log(`${DIM}${ts}${RESET} ${log.level} ${log.message}`);
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
  let transientRetries = 0;
  while (true) {
    let data: { status: string; logs: OpLog[] };
    try {
      data = await get<{ status: string; logs: OpLog[] }>(
        `/api/operations/${id}/logs?since=${cursor}&wait=15000`,
      );
      transientRetries = 0;
    } catch (err) {
      if (err instanceof ApiError && err.isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        console.log(
          `${YELLOW}reconnecting${RESET} ${DIM}(panel unreachable, attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES})${RESET}`,
        );
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`${RED}Lost contact with panel while following op #${id} (${detail})${RESET}`);
      process.exit(1);
    }

    for (const log of data.logs) {
      printLog(log);
      if (log.id > cursor) cursor = log.id;
    }

    if (TERMINAL.has(data.status)) {
      console.log(`\n${colorOpStatus(data.status)}`);
      return;
    }
  }
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd ops [--app <name>] [--limit N]

${BOLD}Subcommands:${RESET}
  (list)                     List deploy engine operations (default)
  <id>                       Show an operation's steps and children
  logs <id> [--follow]       Print an operation's logs (--follow to stream)`);
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
