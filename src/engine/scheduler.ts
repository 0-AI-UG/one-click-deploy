// Per-resource serialization for the engine process.
// Single-process authority — in-memory is sufficient and correct.

type Holder = { opId: number; kind: string };

// Sentinel holder id for non-operation critical sections (e.g. a direct
// ingress re-sync in an HTTP handler) that must serialize against engine
// operations but aren't themselves operations with a real op id.
export const NON_OP_HOLDER = -1;

const holders = new Map<string, Holder>();

export function tryAcquire(
  resourceKeys: string[],
  opId: number,
  kind: string,
): { ok: true } | { ok: false; busyKey: string; heldBy: Holder } {
  for (const key of resourceKeys) {
    const h = holders.get(key);
    if (h) return { ok: false, busyKey: key, heldBy: h };
  }
  for (const key of resourceKeys) {
    holders.set(key, { opId, kind });
  }
  return { ok: true };
}

export function release(resourceKeys: string[]): void {
  for (const key of resourceKeys) holders.delete(key);
}

export function currentHolder(resourceKey: string): Holder | null {
  return holders.get(resourceKey) ?? null;
}

export function heldKeys(): Array<{ key: string; holder: Holder }> {
  return Array.from(holders.entries()).map(([key, holder]) => ({ key, holder }));
}
