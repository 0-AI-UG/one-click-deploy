/** Fail a CLI request when a successful HTTP response has an unexpected or
 * empty payload shape. This prevents transport/proxy bugs from looking like a
 * legitimate empty result. */
export function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} returned a malformed response (expected an object)`);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} returned a malformed response (expected a list)`);
  return value;
}

export function expectStringField(value: unknown, field: string, context: string): string {
  const row = expectRecord(value, context);
  if (typeof row[field] !== "string") {
    throw new Error(`${context} returned a malformed response (missing string field ${field})`);
  }
  return row[field];
}
