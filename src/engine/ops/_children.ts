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
      else if (r.status === "failed" || r.status === "compensated") failed++;
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
        throw new Error("cancelled");
      }
      const allDone = children.length > 0 && children.every((c) => TERMINAL.has(c.status));
      if (children.length === 0 || allDone) {
        const summary = summarize(children);
        ctx.log(`children: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.cancelled} cancelled`);
        if (summary.failed > 0) {
          throw new Error(`${summary.failed} child op(s) failed (succeeded=${summary.succeeded})`);
        }
        return summary;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    ctx.unpark();
  }
}
