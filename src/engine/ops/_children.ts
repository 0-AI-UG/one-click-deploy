import {
  listChildOperations,
  requestCancel,
  type OperationRow,
  type OperationStatus,
} from "../../shared/db/operations.ts";
import type { OpContext } from "../types.ts";

// Operation statuses from which a child op will not transition further.
const TERMINAL: ReadonlySet<OperationStatus> = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
]);

export type ChildSummary = { succeeded: number; failed: number; cancelled: number };

/**
 * Park the current op's engine slot and poll its child operations until they
 * are all terminal, then summarize and throw if any failed. Extracted verbatim
 * from cascade-redeploy's wait loop so parent ops (cascade_redeploy,
 * deploy_stack, destroy_stack) share one implementation.
 *
 * Pass `childIds` to wait on only a subset of the parent's children (e.g. a
 * single topo level, or just the compensating destroys) — children outside the
 * set are ignored. Honors `ctx.isCancelRequested()`: requests cancel on any
 * non-terminal targeted child, then throws.
 */
export async function awaitChildren(
  ctx: OpContext,
  opts?: { childIds?: number[] },
): Promise<ChildSummary> {
  const idFilter = opts?.childIds ? new Set(opts.childIds) : null;
  const select = (rows: OperationRow[]): OperationRow[] =>
    idFilter ? rows.filter((r) => idFilter.has(r.id)) : rows;

  const summarize = (rows: OperationRow[]): ChildSummary => {
    let succeeded = 0, failed = 0, cancelled = 0;
    for (const r of rows) {
      if (r.status === "done") succeeded++;
      else if (r.status === "cancelled") cancelled++;
      else if (
        r.status === "failed" ||
        r.status === "compensated" ||
        r.status === "compensation_failed"
      ) failed++;
    }
    return { succeeded, failed, cancelled };
  };

  // Release the engine concurrency slot while waiting, otherwise a batch of
  // parents can occupy every slot and starve their own children.
  ctx.park();
  try {
    while (true) {
      const children = select(listChildOperations(ctx.opId));
      if (ctx.isCancelRequested()) {
        for (const c of children) {
          if (!TERMINAL.has(c.status)) {
            try { requestCancel(c.id); } catch (err) { ctx.log(`requestCancel #${c.id} failed: ${err}`); }
          }
        }
        const outstanding = children.filter((c) => !TERMINAL.has(c.status));
        if (outstanding.length > 0) {
          ctx.log(
            `cancellation requested; waiting for child compensation: ` +
              outstanding.map((c) => `#${c.id} ${c.kind}=${c.status}`).join(", "),
          );
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        ctx.log("all child operations reached terminal state after cancellation request");
        throw new Error("cancelled");
      }
      const allDone = children.length > 0 && children.every((c) => TERMINAL.has(c.status));
      if (children.length === 0 || allDone) {
        const summary = summarize(children);
        ctx.log(`children: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.cancelled} cancelled`);
        if (summary.failed > 0) {
          const details = children
            .filter((child) =>
              child.status === "failed" ||
              child.status === "compensated" ||
              child.status === "compensation_failed"
            )
            .map((child) => {
              let message: string = child.status;
              try {
                const parsed = JSON.parse(child.error_json || "{}") as { message?: string };
                if (parsed.message) message = parsed.message;
              } catch { /* retain status */ }
              return `#${child.id} ${child.kind}: ${message}`;
            });
          throw new Error(
            `${summary.failed} child op(s) failed (succeeded=${summary.succeeded}): ${details.join("; ")}`,
          );
        }
        return summary;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    ctx.unpark();
  }
}
