/**
 * Durability policy → concrete placement + replica-floor columns.
 *
 * An app's `durability_class` is the ergonomic knob users set (in the manifest
 * or API); the placement layer (server-picker) and the availability sampler
 * (reconciler) both enforce the CONCRETE columns this maps it to. Kept as one
 * pure function so the deploy op's insert path and its finalize path (and tests)
 * all agree on the mapping.
 *
 *   none     → no per-host cap, single location, no replica floor (today's default)
 *   standard → 1 replica per host, single location, >= 2 replicas
 *   high     → 1 replica per host, >= 2 locations, >= 2 replicas
 *
 * `desiredReplicas` floors the caller's requested count (or 1) to the class
 * minimum, so a `standard`/`high` deploy that asked for a single replica still
 * comes up redundant.
 */
export type DurabilityClass = "none" | "standard" | "high";

export function resolveDurability(
  durabilityClass: string | undefined,
  requestedReplicas: number | undefined,
): {
  durabilityClass: DurabilityClass;
  maxPerHost: number;
  minLocations: number;
  /** Replica floor: min_replicas for standard/high, else 1. */
  minReplicas: number;
  /** Requested replicas raised to the floor. */
  desiredReplicas: number;
} {
  const dc: DurabilityClass =
    durabilityClass === "standard" || durabilityClass === "high" ? durabilityClass : "none";
  const maxPerHost = dc === "none" ? 0 : 1;
  const minLocations = dc === "high" ? 2 : 1;
  const minReplicas = dc === "none" ? 1 : 2;
  const desiredReplicas = Math.max(requestedReplicas ?? 1, minReplicas);
  return { durabilityClass: dc, maxPerHost, minLocations, minReplicas, desiredReplicas };
}
