import type { TokenPayload } from "./auth.ts";
import * as db from "../../shared/db.ts";
import { requirePermission } from "./permissions.ts";
import { enforceConfirmation } from "./action-confirm.ts";
import { serverProvisioningResourceId } from "../../shared/server-provisioning.ts";

/** Require one browser approval before a user-initiated operation is allowed
 * to auto-provision billable capacity. Background repair/autoscaling never has
 * this approval and is rejected at the provider-call boundary. */
export async function approveAutomaticServerProvisioning(
  request: Request,
  payload: TokenPayload,
  reason: string,
  pools: string[],
): Promise<void> {
  await requirePermission(request, "servers.create");
  const settings = db.getSettings();
  if (!settings.default_server_type || !settings.default_location) {
    throw new Error("Default server type and location must be configured before automatic provisioning");
  }
  const resourceId = serverProvisioningResourceId({
    serverType: settings.default_server_type,
    location: settings.default_location,
    pools: pools.length ? pools : ["general"],
    reason,
  });
  await enforceConfirmation(request, payload, "create_server", "server_plan", resourceId);
}
