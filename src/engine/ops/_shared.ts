import * as db from "../../shared/db.ts";
import type { Step } from "../types.ts";

// Shared boilerplate for the destroy_* ops. Destroy steps are best-effort: each
// logs its failures and continues. There are no compensations — nothing to undo
// for a deletion that partially succeeded — so partial failures are surfaced via
// the db-cleanup gate (see runDbCleanupGate) instead.

export async function softStep<T>(
  ctx: { log: (s: string) => void },
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[${name}] failed (continuing): ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Scan prior step outputs for partial failures. A step is considered failed if
 * its output has `failed === true` or `ok === false`. Returns the names of the
 * failed steps (empty when everything succeeded). Callers gate their DB-row
 * deletion on this and set their own resource-specific `cleanup_failed` status.
 */
export function runDbCleanupGate(prior: Record<string, unknown>): string[] {
  const failedSteps: string[] = [];
  for (const [name, out] of Object.entries(prior)) {
    if (!out || typeof out !== "object") continue;
    const o = out as { ok?: boolean; failed?: boolean };
    if (o.failed === true || o.ok === false) failedSteps.push(name);
  }
  return failedSteps;
}

/**
 * Turn best-effort cleanup outputs back into a hard operation boundary.
 *
 * Deletion steps use softStep so every independent resource gets an attempt,
 * but an operation must not subsequently report success when one of those
 * attempts failed. Keep this assertion in a separate final step so the failed
 * best-effort step's output is durably recorded and available after a resume.
 */
export function assertCleanupComplete(
  prior: Record<string, unknown>,
  stepNames?: string[],
): void {
  const failures = runDbCleanupGate(prior).filter((name) => !stepNames || stepNames.includes(name));
  if (failures.length > 0) {
    throw new Error(`Cleanup incomplete (failed: ${failures.join(", ")})`);
  }
}

/**
 * GC-empty-servers step, parameterized by the name of the prior step that
 * reported the affected server ids in its `affectedServerIds` field.
 */
export function makeGcEmptyServersStep<I>(priorKey: string): Step<I, { ok: true }> {
  return {
    name: "gc_empty_servers",
    label: "GC empty servers",
    async run(ctx, prior) {
      const containers = prior[priorKey] as { affectedServerIds: number[] } | undefined;
      const ids = containers?.affectedServerIds || [];
      for (const sid of ids) {
        await softStep(ctx, `gc_server ${sid}`, async () => {
          await db.gcServerIfEmpty(sid);
        });
      }
      return { ok: true };
    },
  };
}
