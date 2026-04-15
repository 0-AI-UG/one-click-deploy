import * as db from "../shared/db.ts";
import { getComputeProvider } from "../shared/providers/index.ts";

/**
 * Ensure the shared private network exists at the provider level and that its
 * id is persisted in the `network_id` setting. Returns the stored id.
 *
 * Callers should invoke this from any code path that is about to create a
 * server (so new servers get attached to the network at boot) or attach an
 * existing server (reconciler pass).
 */
export async function ensureNetwork(): Promise<string> {
  const compute = getComputeProvider();
  if (!compute.networks) {
    // Provider doesn't support private networking — silently degrade. Callers
    // fall back to the public IPv4 path.
    return "";
  }
  const settings = db.getSettings();
  const stored = settings.network_id;
  if (stored) return stored;
  const { id } = await compute.networks.ensure();
  db.saveSetting("network_id", id);
  return id;
}

/** Read the persisted network id without touching the provider API. */
export function getStoredNetworkId(): string {
  return db.getSettings().network_id || "";
}
