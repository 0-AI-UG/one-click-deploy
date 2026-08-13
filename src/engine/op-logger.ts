import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import db from "../shared/db/connection.ts";

type OpStore = { opId: number; attempt: number };

const als = new AsyncLocalStorage<OpStore>();

export type OpLogRow = {
  id: number;
  op_id: number;
  ts: string;
  level: string;
  message: string;
  attempt: number;
};

export function withOpContext<T>(opId: number, attempt: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ opId, attempt }, fn);
}

export function currentOpId(): number | null {
  return als.getStore()?.opId ?? null;
}

export function appendOpLog(opId: number, level: string, message: string, attempt = 1): void {
  try {
    db.run(
      "INSERT INTO operation_logs (op_id, level, message, attempt) VALUES (?, ?, ?, ?)",
      [opId, level, message.length > 8000 ? message.slice(0, 8000) + "…[truncated]" : message, attempt],
    );
  } catch {
    // Never let log persistence break the engine.
  }
}

export function getOpLogs(opId: number, sinceId = 0, limit = 1000): OpLogRow[] {
  return db
    .query(
      `SELECT id, op_id, ts, level, message, attempt FROM operation_logs
        WHERE op_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(opId, sinceId, limit) as OpLogRow[];
}

/** Read the newest rows without scanning/transferring the whole operation log.
 * The outer query restores chronological display order. */
export function getOpLogTail(opId: number, limit: number, sinceId = 0): OpLogRow[] {
  return db
    .query(
      `SELECT id, op_id, ts, level, message, attempt FROM (
         SELECT id, op_id, ts, level, message, attempt FROM operation_logs
          WHERE op_id = ? AND id > ?
          ORDER BY id DESC
          LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(opId, sinceId, limit) as OpLogRow[];
}

export interface OpLogFilters {
  sinceId?: number;
  sinceTime?: string;
  phase?: string;
  limit?: number;
  tail?: boolean;
}

/** Filter operation logs at the database. A phase may be either a step name
 * (build, transfer, health_check, …) or the forward/compensate direction. The
 * timestamp join avoids a schema migration while still correlating a log line
 * with the step that was active when it was emitted. */
export function getFilteredOpLogs(opId: number, filters: OpLogFilters = {}): OpLogRow[] {
  const sinceId = filters.sinceId ?? 0;
  const sinceTime = filters.sinceTime ?? "";
  const phase = filters.phase ?? "";
  const limit = Math.min(Math.max(filters.limit ?? 1000, 1), 5000);
  const order = filters.tail ? "DESC" : "ASC";
  const rows = db.query(
    `SELECT l.id, l.op_id, l.ts, l.level, l.message, l.attempt
       FROM operation_logs l
      WHERE l.op_id = ? AND l.id > ?
        AND (? = '' OR l.ts >= ?)
        AND (? = '' OR ? = COALESCE((
          SELECT CASE WHEN ? IN ('forward', 'compensate') THEN s.phase ELSE s.step END
            FROM operation_steps s
           WHERE s.op_id = l.op_id AND l.ts >= s.started_at
           ORDER BY s.started_at DESC, s.seq DESC
           LIMIT 1
        ), ''))
      ORDER BY l.id ${order}
      LIMIT ?`,
  ).all(opId, sinceId, sinceTime, sinceTime, phase, phase, phase, limit) as OpLogRow[];
  return filters.tail ? rows.reverse() : rows;
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) {
    try {
      return inspect(a, { depth: 4, breakLength: 120 });
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function formatLine(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

let patched = false;

/**
 * Patch console.{log,info,warn,error} to also persist every line written
 * while inside an `withOpContext()` scope into operation_logs. Idempotent.
 *
 * Engine modules already log via console.log; this captures them all without
 * touching each module.
 */
export function patchConsoleForOpLogs(): void {
  if (patched) return;
  patched = true;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function emit(level: string, args: unknown[]): void {
    const store = als.getStore();
    if (!store) return;
    appendOpLog(store.opId, level, formatLine(args), store.attempt);
  }

  console.log = (...args: unknown[]) => { orig.log(...args); emit("info", args); };
  console.info = (...args: unknown[]) => { orig.info(...args); emit("info", args); };
  console.warn = (...args: unknown[]) => { orig.warn(...args); emit("warn", args); };
  console.error = (...args: unknown[]) => { orig.error(...args); emit("error", args); };
}
