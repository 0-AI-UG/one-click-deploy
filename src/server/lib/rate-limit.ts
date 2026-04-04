export class RateLimiter {
  private windows = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxAttempts: number,
    private windowMs: number,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
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
      return { allowed: false, retryAfterSeconds };
    }

    timestamps.push(now);
    return { allowed: true, retryAfterSeconds: 0 };
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
