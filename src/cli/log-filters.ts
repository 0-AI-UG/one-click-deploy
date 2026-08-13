import { parseCliArgs, positiveIntegerFlag } from "./args.ts";

export interface ParsedLogArgs {
  target: string;
  tail: number;
  cursor: number;
  sinceTime?: string;
  child?: string;
  phase?: string;
  follow: boolean;
}

export function parseSince(raw: string | undefined): { cursor: number; sinceTime?: string } {
  if (!raw) return { cursor: 0 };
  if (/^\d+$/.test(raw)) return { cursor: Number(raw) };
  const duration = /^(\d+)(s|m|h|d)$/.exec(raw);
  let date: Date;
  if (duration) {
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as "s" | "m" | "h" | "d"];
    date = new Date(Date.now() - Number(duration[1]) * unitMs);
  } else {
    date = new Date(raw);
  }
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--since must be a log cursor, ISO timestamp, or duration such as 30m, 2h, or 1d");
  }
  return { cursor: 0, sinceTime: date.toISOString() };
}

export function parseLogArgs(args: string[], opts: { requireTarget?: boolean } = {}): ParsedLogArgs {
  const parsed = parseCliArgs(args, {
    follow: { type: "boolean", aliases: ["f"] },
    since: { type: "string" },
    tail: { type: "string" },
    child: { type: "string" },
    phase: { type: "string" },
  }, { maxPositionals: 1 });
  const target = parsed.positionals[0] || "";
  if (opts.requireTarget !== false && !target) throw new Error("A log target is required");
  const since = parseSince(parsed.flags.since as string | undefined);
  return {
    target,
    tail: positiveIntegerFlag(parsed.flags.tail, "tail", { defaultValue: 0, max: 5000 }) ?? 0,
    ...since,
    child: parsed.flags.child as string | undefined,
    phase: parsed.flags.phase as string | undefined,
    follow: parsed.flags.follow === true,
  };
}

export function operationLogQuery(filters: Omit<ParsedLogArgs, "target" | "follow"> & { wait?: number }): string {
  const params = new URLSearchParams({ since: String(filters.cursor) });
  if (filters.tail > 0) params.set("tail", String(filters.tail));
  if (filters.sinceTime) params.set("since_time", filters.sinceTime);
  if (filters.child) params.set("child", filters.child);
  if (filters.phase) params.set("phase", filters.phase);
  if (filters.wait) params.set("wait", String(filters.wait));
  return params.toString();
}
