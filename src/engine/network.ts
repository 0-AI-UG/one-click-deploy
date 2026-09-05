import * as db from "../shared/db.ts";
import type { InfrastructureProvider } from "../shared/providers/index.ts";
import { requireDefaultInfrastructureProvider } from "../shared/infrastructure.ts";

/**
 * Ensure the shared private network exists at the provider level and that its
 * id is persisted in the `network_id` setting. Returns the stored id.
 *
 * Callers should invoke this from any code path that is about to create a
 * server (so new servers get attached to the network at boot) or attach an
 * existing server (reconciler pass).
 */
export async function ensureNetwork(
  provider: InfrastructureProvider = requireDefaultInfrastructureProvider(db.getSettings()),
): Promise<string> {
  const compute = provider;
  if (!compute.networks) {
    // Provider doesn't support private networking — silently degrade. Callers
    // fall back to the public IPv4 path.
    return "";
  }
  const settings = db.getSettings();
  const settingKey = `network_id.${provider.id}`;
  const stored = settings[settingKey];
  if (stored) return stored;
  const { id } = await compute.networks.ensure();
  db.saveSetting(settingKey, id);
  return id;
}

/** Read the persisted network id without touching the provider API. */
export function getStoredNetworkId(providerId: string): string {
  return db.getSettings()[`network_id.${providerId}`] || "";
}
