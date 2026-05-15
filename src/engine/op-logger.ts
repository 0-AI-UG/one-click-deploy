import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import db from "../shared/db/connection.ts";

type OpStore = { opId: number };

const als = new AsyncLocalStorage<OpStore>();

export type OpLogRow = {
  id: number;
  op_id: number;
  ts: string;
  level: string;
  message: string;
};

export function withOpContext<T>(opId: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ opId }, fn);
}

export function currentOpId(): number | null {
  return als.getStore()?.opId ?? null;
}

export function appendOpLog(opId: number, level: string, message: string): void {
  try {
    db.run(
      "INSERT INTO operation_logs (op_id, level, message) VALUES (?, ?, ?)",
      [opId, level, message.length > 8000 ? message.slice(0, 8000) + "…[truncated]" : message],
    );
  } catch {
    // Never let log persistence break the engine.
  }
}

export function getOpLogs(opId: number, sinceId = 0, limit = 1000): OpLogRow[] {
  return db
    .query(
      `SELECT id, op_id, ts, level, message FROM operation_logs
        WHERE op_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(opId, sinceId, limit) as OpLogRow[];
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
    appendOpLog(store.opId, level, formatLine(args));
  }

  console.log = (...args: unknown[]) => { orig.log(...args); emit("info", args); };
  console.info = (...args: unknown[]) => { orig.info(...args); emit("info", args); };
  console.warn = (...args: unknown[]) => { orig.warn(...args); emit("warn", args); };
  console.error = (...args: unknown[]) => { orig.error(...args); emit("error", args); };
}
