export class RateLimiter {
  private windows = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxAttempts: number,
    private windowMs: number,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** Check whether the key is rate-limited without recording an attempt. */
  isLimited(key: string): { limited: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (timestamps) {
      timestamps = timestamps.filter((t) => t > cutoff);
      this.windows.set(key, timestamps);
    } else {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    if (timestamps.length >= this.maxAttempts) {
      const oldest = timestamps[0]!;
      const retryAfterSeconds = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { limited: true, retryAfterSeconds };
    }

    return { limited: false, retryAfterSeconds: 0 };
  }

  /** Record a failed attempt for the given key. */
  recordFailure(key: string): void {
    const now = Date.now();
    const timestamps = this.windows.get(key);
    if (timestamps) {
      timestamps.push(now);
    } else {
      this.windows.set(key, [now]);
    }
  }

  private cleanup() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, valid);
      }
    }
  }
}

/** 10 attempts per 15 minutes for auth endpoints */
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);
