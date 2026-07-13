/**
 * True when a provider API call failed because the resource is already gone.
 * Hetzner returns `error.code: not_found`, which `friendlyHetznerError` (and the
 * 404 route fallback) surfaces as a "...not found..." message. Teardown
 * compensations use this to treat an already-deleted resource as success
 * (idempotent) while still letting transient errors (5xx, rate-limit, network)
 * propagate as real failures instead of being mistaken for "already gone" — the
 * latter would skip the delete and silently leak the resource.
 *
 * Lives in its own module (not index.ts) so it survives the `mock.module` swaps
 * that tests use to fake the provider — it is pure logic, never mocked.
 */
export function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg);
}
