// Helper used by the HTTP/panel process to enqueue an op for the engine.
// The engine picks up the row by polling the operations table — no IPC needed.

import { enqueueOperation } from "../../shared/db/operations.ts";
import type { EnqueueInput } from "../../shared/db/operations.ts";
import * as db from "../../shared/db.ts";

/**
 * HTTP-triggered member operations must serialize with their owning stack's
 * reconcile/destroy operation. Engine-spawned children bypass this helper and
 * deliberately keep only their member key, otherwise a parent waiting on its
 * children would deadlock while retaining the stack lock.
 */
export function withOwningStackKeys(args: EnqueueInput): EnqueueInput {
  const keys = new Set(args.resourceKeys);
  for (const key of args.resourceKeys) {
    const match = /^(app|service):(\d+)$/.exec(key);
    if (!match) continue;
    const id = Number(match[2]);
    let stackId: number | null = null;
    if (match[1] === "app") {
      const app = db.getApp(id);
      if (!app) continue;
      stackId = app.stack_id;
      if (stackId == null && app.target_of != null) {
        stackId = db.getApp(app.target_of)?.stack_id ?? null;
      }
    } else {
      stackId = db.getService(id)?.stack_id ?? null;
    }
    if (stackId == null) continue;
    const stack = db.getStack(stackId);
    if (!stack) continue;
    keys.add(`stack:${stack.id}`);
    keys.add(`stack:${stack.name}`);
  }
  return { ...args, resourceKeys: [...keys] };
}

export function enqueue(args: EnqueueInput): { opId: number } {
  const row = enqueueOperation(withOwningStackKeys(args));
  return { opId: row.id };
}
