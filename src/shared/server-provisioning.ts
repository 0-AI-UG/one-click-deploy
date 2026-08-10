export type ServerProvisioningPlan = {
  serverType: string;
  location: string;
  pools: string[];
  reason: string;
};

/** Stable resource identity used to bind browser approval to one exact
 * billable-capacity plan. Arrays keep the encoding compact and deterministic. */
export function serverProvisioningResourceId(plan: ServerProvisioningPlan): string {
  return JSON.stringify([
    plan.serverType,
    plan.location,
    [...new Set(plan.pools)].sort(),
    plan.reason,
  ]);
}

export function parseServerProvisioningResourceId(resourceId: string): ServerProvisioningPlan | null {
  try {
    const parsed = JSON.parse(resourceId) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [serverType, location, pools, reason] = parsed;
    if (
      typeof serverType !== "string" || !serverType ||
      typeof location !== "string" || !location ||
      !Array.isArray(pools) || pools.length === 0 ||
      !pools.every((pool) => typeof pool === "string" && pool.length > 0) ||
      typeof reason !== "string" || !reason
    ) return null;
    return { serverType, location, pools: [...new Set(pools)].sort(), reason };
  } catch {
    return null;
  }
}
