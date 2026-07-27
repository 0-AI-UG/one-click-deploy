// Helper used by the HTTP/panel process to enqueue an op for the engine.
// The engine picks up the row by polling the operations table — no IPC needed.

import { enqueueOperation } from "../../shared/db/operations.ts";
import type { EnqueueInput } from "../../shared/db/operations.ts";
import { withOwningStackKeys } from "../lib/stack-operations.ts";

export function enqueue(args: EnqueueInput): { opId: number } {
  const row = enqueueOperation(withOwningStackKeys(args));
  return { opId: row.id };
}
