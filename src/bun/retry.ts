function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [retry:${context}]`, ...args);
}

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: (error: Error) => boolean;
};

const defaultOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export function isRetryableHttpError(err: Error): boolean {
  const msg = err.message;
  // Retry on rate limits and server errors
  if (/\b(429|500|502|503)\b/.test(msg)) return true;
  // Retry on network errors
  if (/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network)\b/i.test(msg))
    return true;
  return false;
}

export function isRetryableSshError(err: Error): boolean {
  const msg = err.message;
  if (/\b(Connection refused|Connection reset|Connection timed out)\b/i.test(msg))
    return true;
  if (/\b(No route to host|Network is unreachable)\b/i.test(msg))
    return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, retryOn } = {
    ...defaultOptions,
    ...opts,
  };

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;

      const shouldRetry = retryOn ? retryOn(lastError) : true;
      if (!shouldRetry) break;

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        maxDelayMs
      );
      log(
        "attempt",
        `Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`
      );
      await Bun.sleep(delay);
    }
  }

  throw lastError;
}
