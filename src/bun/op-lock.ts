// In-memory per-resource operation lock.
//
// Keys follow the pattern "app:42", "server:7", "service:3".
// Single-process only — locks clear automatically on restart.

type QueueEntry = {
  resolve: () => void;
  operationName: string;
};

type LockState = {
  holder: string;
  queue: QueueEntry[];
};

const locks = new Map<string, LockState>();

/**
 * Try to acquire the lock without waiting.
 * Returns `{ release }` on success, or `{ busy, holder }` if held.
 */
export function tryAcquireLock(
  resourceKey: string,
  operationName: string,
): { release: () => void } | { busy: true; holder: string } {
  const existing = locks.get(resourceKey);
  if (existing) return { busy: true, holder: existing.holder };
  locks.set(resourceKey, { holder: operationName, queue: [] });
  return { release: () => releaseLock(resourceKey) };
}

/**
 * Acquire the lock, waiting in a FIFO queue if held.
 * Returns a release function — caller MUST call it in a finally block.
 */
export async function acquireLock(
  resourceKey: string,
  operationName: string,
): Promise<() => void> {
  const existing = locks.get(resourceKey);
  if (!existing) {
    locks.set(resourceKey, { holder: operationName, queue: [] });
    return () => releaseLock(resourceKey);
  }
  return new Promise<() => void>((resolve) => {
    existing.queue.push({
      operationName,
      resolve: () => {
        locks.get(resourceKey)!.holder = operationName;
        resolve(() => releaseLock(resourceKey));
      },
    });
  });
}

/**
 * Atomically try to acquire multiple locks (all-or-nothing).
 * Used by destroyServer to lock the server + all its apps/services.
 */
export function tryAcquireMulti(
  resourceKeys: string[],
  operationName: string,
): { release: () => void } | { busy: true; holder: string; resourceKey: string } {
  const acquired: string[] = [];
  for (const key of resourceKeys) {
    const result = tryAcquireLock(key, operationName);
    if ("busy" in result) {
      for (const k of acquired) releaseLock(k);
      return { busy: true, holder: result.holder, resourceKey: key };
    }
    acquired.push(key);
  }
  return { release: () => { for (const key of acquired) releaseLock(key); } };
}

function releaseLock(resourceKey: string): void {
  const state = locks.get(resourceKey);
  if (!state) return;
  const next = state.queue.shift();
  if (next) {
    next.resolve();
  } else {
    locks.delete(resourceKey);
  }
}

/** Check if a resource is currently locked. */
export function isLocked(resourceKey: string): boolean {
  return locks.has(resourceKey);
}

/** For tests. */
export function _resetLocks(): void {
  locks.clear();
}
