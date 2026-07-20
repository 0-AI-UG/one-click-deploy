import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

/** The always-present default pools — surfaced even when no server or app uses
 *  them, so the UI can always offer them as placement targets. */
const DEFAULT_POOLS = ["general", "staging"];

/** GET /api/pools — sorted, de-duplicated union of every capacity pool any
 *  server or app currently references, plus the always-present defaults. A pool
 *  exists implicitly the moment a server or app is assigned to it (there is no
 *  pools table). */
export async function handleGetPools(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const pools = [
      ...DEFAULT_POOLS,
      ...db.getDistinctServerPools(),
      ...db.getDistinctPlacementPools(),
    ];
    return Response.json({ pools: [...new Set(pools)].sort() }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
