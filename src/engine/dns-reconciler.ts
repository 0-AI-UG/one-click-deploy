import { resolve4 } from "node:dns/promises";
import * as db from "../shared/db.ts";
import { hetznerDns } from "../shared/providers/index.ts";
import { getPanelIngressIpv4 } from "./scale/traefik-manager.ts";

export type DnsReadiness = {
  managed: boolean;
  domain: string;
  expectedTarget: string;
  resolved: string[];
  ready: boolean;
  error?: string;
};

function withinZone(domain: string, zone: string): boolean {
  const d = domain.replace(/\.$/, "").toLowerCase();
  const z = zone.replace(/\.$/, "").toLowerCase();
  return !!z && (d === z || d.endsWith(`.${z}`));
}

function recordName(domain: string, zone: string): string {
  const d = domain.replace(/\.$/, "");
  const z = zone.replace(/\.$/, "");
  return d.toLowerCase() === z.toLowerCase() ? "@" : d.slice(0, -(z.length + 1));
}

async function resolvedIps(domain: string): Promise<string[]> {
  try { return await resolve4(domain); } catch { return []; }
}

/** Reconcile an app's public A record as desired state. Provider failures are
 * surfaced to callers and persisted as endpoint degradation. */
export async function reconcileAppDns(appId: number): Promise<DnsReadiness> {
  const app = db.getApp(appId);
  if (!app) throw new Error(`App ${appId} not found`);
  if (!app.public || !app.domain) {
    db.updateAppPublicEndpointStatus(app.id, "not_applicable");
    return { managed: false, domain: app.domain || "", expectedTarget: "", resolved: [], ready: true };
  }
  const target = getPanelIngressIpv4() || "";
  if (!target) {
    const error = "panel ingress IPv4 is unavailable";
    db.updateAppPublicEndpointStatus(app.id, "degraded", error);
    throw new Error(error);
  }
  const settings = db.getSettings();
  const zoneId = settings.dns_zone_id || "";
  let zoneName = settings.dns_zone_name || "";
  if (zoneId && !zoneName) {
    try {
      const zone = (await hetznerDns.listZones()).find(
        (candidate: { id: string; name: string }) => candidate.id === zoneId,
      );
      if (!zone?.name) throw new Error(`configured DNS zone ${zoneId} was not found`);
      zoneName = zone.name.replace(/\.$/, "");
      db.saveSetting("dns_zone_name", zoneName);
    } catch (err) {
      const error = `DNS zone resolution failed for ${zoneId}: ${err instanceof Error ? err.message : err}`;
      db.updateAppPublicEndpointStatus(app.id, "degraded", error);
      throw new Error(error);
    }
  }
  const managed = !!zoneId && withinZone(app.domain, zoneName);
  let resolved = await resolvedIps(app.domain);
  const name = managed ? recordName(app.domain, zoneName) : "";
  if (managed) {
    try {
      // Remove OCD's obsolete recorded values before converging the target.
      for (const stale of db.getDnsRecords(app.id).filter((r) =>
        r.zone_id !== zoneId || r.name !== name || r.type !== "A" || r.value !== target
      )) {
        await hetznerDns.deleteRecord({
          zoneId: stale.zone_id,
          name: stale.name,
          type: stale.type,
          value: stale.value,
        });
        db.deleteDnsRecord(stale.record_id);
      }
      // createRecord performs an authoritative RRSet lookup and is
      // idempotent. Run it even when recursive DNS still has the expected
      // value cached so a provider-side deletion is repaired immediately.
      const record = await hetznerDns.createRecord({ zoneId, name, type: "A", value: target });
      const tracked = db.getDnsRecords(app.id).some((r) =>
        r.zone_id === zoneId && r.name === name && r.type === "A" && r.value === target
      );
      if (!tracked) {
        db.insertDnsRecord({
          app_id: app.id,
          zone_id: zoneId,
          record_id: record.id,
          name,
          type: "A",
          value: target,
        });
      }
      // DNS propagation can lag the authoritative write; the resource is
      // converged, while public readiness remains pending until resolution.
      resolved = await resolvedIps(app.domain);
    } catch (err) {
      const error = `DNS reconciliation failed for ${app.domain}: ${err instanceof Error ? err.message : err}`;
      db.updateAppPublicEndpointStatus(app.id, "degraded", error);
      throw new Error(error);
    }
  }
  const ready = resolved.includes(target);
  const error = ready
    ? ""
    : managed
      ? `DNS change pending: ${app.domain} must resolve to ${target}`
      : `Unmanaged domain ${app.domain} resolves to ${resolved.join(", ") || "nothing"}; expected ${target}`;
  db.updateAppPublicEndpointStatus(app.id, ready ? "ready" : "degraded", error);
  return { managed, domain: app.domain, expectedTarget: target, resolved, ready, error: error || undefined };
}

export async function reconcileAllAppDns(): Promise<void> {
  for (const app of db.getApps()) {
    if (!app.public || !app.domain) continue;
    try { await reconcileAppDns(app.id); }
    catch (err) { console.warn(`[dns:reconcile] app ${app.id}: ${err}`); }
  }
}

export type PublicEndpointReadiness = DnsReadiness & {
  tlsReady: boolean;
  httpStatus?: number;
  tlsError?: string;
};

export async function validatePublicEndpoint(appId: number): Promise<PublicEndpointReadiness> {
  const dns = await reconcileAppDns(appId);
  if (!dns.ready) return { ...dns, tlsReady: false, tlsError: dns.error };
  const app = db.getApp(appId)!;
  if (app.domain.endsWith(".nip.io")) {
    // nip.io deliberately uses a self-signed certificate; DNS is the public
    // readiness contract for that development-only domain class.
    return { ...dns, tlsReady: true };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://${app.domain}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    const tlsReady = response.status > 0 && response.status < 600;
    const error = tlsReady ? "" : `HTTPS returned ${response.status}`;
    db.updateAppPublicEndpointStatus(app.id, tlsReady ? "ready" : "degraded", error);
    return { ...dns, tlsReady, httpStatus: response.status, tlsError: error || undefined };
  } catch (err) {
    const tlsError = `HTTPS/TLS validation failed: ${err instanceof Error ? err.message : err}`;
    db.updateAppPublicEndpointStatus(app.id, "degraded", tlsError);
    return { ...dns, tlsReady: false, tlsError };
  } finally {
    clearTimeout(timeout);
  }
}
