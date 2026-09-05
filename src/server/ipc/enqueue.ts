import { recoveryPending } from "../../engine/panel-protection/recovery-state.ts";
// Helper used by the HTTP/panel process to enqueue an op for the engine.
// The engine picks up the row by polling the operations table — no IPC needed.

import { enqueueOperation } from "../../shared/db/operations.ts";
import type { EnqueueInput } from "../../shared/db/operations.ts";
import { withOwningStackKeys } from "../lib/stack-operations.ts";

export function enqueue(args: EnqueueInput): { opId: number } {
  if (recoveryPending()) throw new Error("Panel recovery is paused; verify and resume in Admin → Panel first");
  const row = enqueueOperation(withOwningStackKeys(args));
  return { opId: row.id };
}
