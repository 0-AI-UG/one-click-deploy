import { get } from "./api.ts";
import { CYAN, GREEN, RED, RESET } from "./format.ts";

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

/**
 * Poll an operation until it reaches a terminal state, printing step events
 * as they arrive. Returns ok=true only if the op completed successfully.
 */
export async function followOp(opId: number): Promise<{ ok: boolean; error?: string }> {
  let lastSeq = 0;
  while (true) {
    const poll = await get<OperationEventPoll>(
      `/api/operations/${opId}/events?since=${lastSeq}&wait=15000`,
    );

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
