import { resolve4 } from "node:dns/promises";
import * as db from "../shared/db.ts";
import { hetznerDns } from "../shared/providers/index.ts";
import { getOrResolveZoneName } from "../shared/dns-zone.ts";
import { getPanelIngressIpv4 } from "./scale/traefik-manager.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";

export type DnsReadiness = {
  managed: boolean;
  domain: string;
  expectedTarget: string;
  resolved: string[];
  ready: boolean;
  error?: string;
};

type ReconcileOptions = { alreadyLocked?: boolean; skipIfBusy?: boolean };

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

async function deleteTrackedAppRecords(appId: number): Promise<void> {
  for (const record of db.getDnsRecords(appId)) {
    await hetznerDns.deleteRecord({
      zoneId: record.zone_id,
      name: record.name,
      type: record.type,
      value: record.value,
    });
    db.deleteDnsRecord(record.record_id);
  }
}

/** Reconcile an app's public A record in both directions. The app lock prevents
 * this controller from recreating a record while a destroy/redeploy operation
 * owns the same app. */
export async function reconcileAppDns(
  appId: number,
  options: ReconcileOptions = {},
): Promise<DnsReadiness> {
  const keys = [`app:${appId}`];
  let acquired = false;
  if (!options.alreadyLocked) {
    const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:dns");
    if (!lock.ok) {
      const app = db.getApp(appId);
      const error = `DNS reconciliation deferred: ${lock.busyKey} is held by ${lock.heldBy.kind}`;
      if (options.skipIfBusy) {
        return {
          managed: false,
          domain: app?.domain || "",
          expectedTarget: "",
          resolved: [],
          ready: false,
          error,
        };
      }
      throw new Error(error);
    }
    acquired = true;
  }
  try {
    const app = db.getApp(appId);
    if (!app) throw new Error(`App ${appId} not found`);
    if (app.deletion_requested_at || !app.public || !app.domain) {
      await deleteTrackedAppRecords(app.id);
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
      zoneName = await getOrResolveZoneName();
      if (!zoneName) {
        const error = `DNS zone resolution failed: configured zone ${zoneId} was not found`;
        db.updateAppPublicEndpointStatus(app.id, "degraded", error);
        throw new Error(error);
      }
    }
    const managed = !!zoneId && withinZone(app.domain, zoneName);
    let resolved = await resolvedIps(app.domain);
    const name = managed ? recordName(app.domain, zoneName) : "";
    if (!managed) await deleteTrackedAppRecords(app.id);
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
  } finally {
    if (acquired) release(keys);
  }
}

export async function reconcileAllAppDns(): Promise<void> {
  const apps = db.getApps();
  let next = 0;
  const workers = Array.from({ length: Math.min(5, apps.length) }, async () => {
    while (next < apps.length) {
      const app = apps[next++];
      try { await reconcileAppDns(app.id, { skipIfBusy: true }); }
      catch (err) { console.warn(`[dns:reconcile] app ${app.id}: ${err}`); }
    }
  });
  await Promise.all(workers);
}

async function deleteTrackedPanelRecord(): Promise<void> {
  const panel = db.getPanel();
  if (!panel?.dns_zone_id || !panel.dns_name || !panel.dns_type || !panel.dns_value) return;
  await hetznerDns.deleteRecord({
    zoneId: panel.dns_zone_id,
    name: panel.dns_name,
    type: panel.dns_type,
    value: panel.dns_value,
  });
  db.clearPanelDnsRecord();
}

/** The panel is not an apps-table row, so its bootstrap DNS record has its own
 * desired-state adapter. This repairs the historical best-effort bootstrap
 * path and removes obsolete records when the configured zone changes. */
export async function reconcilePanelDns(): Promise<void> {
  const panel = db.getPanel();
  if (!panel) return;
  const keys = [`server:${panel.server_id}`];
  const lock = tryAcquire(keys, NON_OP_HOLDER, "reconcile:panel-dns");
  if (!lock.ok) return;
  try {
    const server = db.getServer(panel.server_id);
    const settings = db.getSettings();
    const zoneId = settings.dns_zone_id || "";
    let zoneName = settings.dns_zone_name || "";
    if (zoneId && !zoneName) zoneName = await getOrResolveZoneName();
    const desired = !!server?.ipv4 && !!zoneId && withinZone(panel.domain, zoneName);
    if (!desired) {
      await deleteTrackedPanelRecord();
      return;
    }
    const name = recordName(panel.domain, zoneName);
    const stale = panel.dns_zone_id && (
      panel.dns_zone_id !== zoneId || panel.dns_name !== name ||
      panel.dns_type !== "A" || panel.dns_value !== server!.ipv4
    );
    if (stale) await deleteTrackedPanelRecord();
    await hetznerDns.createRecord({
      zoneId,
      name,
      type: "A",
      value: server!.ipv4,
    });
    db.updatePanelDnsRecord({
      zone_id: zoneId,
      name,
      type: "A",
      value: server!.ipv4,
    });
  } finally {
    release(keys);
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
