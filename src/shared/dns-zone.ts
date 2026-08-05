// Auto-domain support: apps deployed without an explicit domain get
// `<app>.<zone>` when a DNS zone is configured. The zone *name* is resolved
// from the provider once and cached in the settings KV under `dns_zone_name`
// so deploys never need a network round-trip in the common case.
import * as db from "./db.ts";
import { hetznerDns } from "./providers/index.ts";

/** A configured selector may be either an opaque provider id or the canonical
 * zone name itself. A DNS name already provides the suffix needed for safe
 * ownership validation; the provider write remains the authority check. */
export function zoneNameFromSelector(selector: string): string {
  const normalized = selector.replace(/\.$/, "").toLowerCase();
  return normalized.includes(".") && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
    ? normalized
    : "";
}

/** Resolve the name of `zoneId` via the DNS provider and cache it in the
 *  `dns_zone_name` setting. Best-effort: an unknown zone id or a provider
 *  error clears the cached name and returns "" — callers fall back to nip.io.
 *  Called eagerly whenever `dns_zone_id` is saved (empty id clears the name)
 *  and lazily from deploy when the id is set but the name was never resolved. */
export async function syncZoneNameSetting(zoneId: string): Promise<string> {
  if (!zoneId) {
    db.saveSetting("dns_zone_name", "");
    return "";
  }
  let name = zoneNameFromSelector(zoneId);
  if (name) {
    db.saveSetting("dns_zone_name", name);
    return name;
  }
  try {
    const zones = await hetznerDns.listZones();
    name = zones.find((z: { id: string; name: string }) => z.id === zoneId)?.name ?? "";
  } catch {
    // Provider unreachable — leave the name cleared; the lazy path retries.
  }
  db.saveSetting("dns_zone_name", name);
  return name;
}

/** Zone name for the configured `dns_zone_id`: cached value if present,
 *  otherwise fetched from the provider and cached. "" when no zone is
 *  configured or the name cannot be resolved. */
export async function getOrResolveZoneName(): Promise<string> {
  const settings = db.getSettings();
  if (!settings.dns_zone_id) return "";
  if (settings.dns_zone_name) return settings.dns_zone_name;
  return syncZoneNameSetting(settings.dns_zone_id);
}
