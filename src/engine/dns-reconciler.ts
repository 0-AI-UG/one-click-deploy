import { resolve4 } from "node:dns/promises";
import * as db from "../shared/db.ts";
import { getCatalogEntry } from "../shared/services/catalog.ts";
import { getPanelIngressIpv4 } from "./scale/traefik-manager.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";

export type DnsInstructionStatus = "pending" | "correct" | "conflicting" | "not_applicable";

export type DnsInstruction = {
  status: DnsInstructionStatus;
  record: { type: "A"; name: string; value: string } | null;
  observedValues: string[];
  message: string;
};

export type DnsReadiness = DnsInstruction & {
  domain: string;
  expectedTarget: string;
  resolved: string[];
  ready: boolean;
};

type ReconcileOptions = { alreadyLocked?: boolean; skipIfBusy?: boolean };

function notApplicable(message: string, domain = ""): DnsReadiness {
  return {
    status: "not_applicable",
    record: null,
    observedValues: [],
    message,
    domain,
    expectedTarget: "",
    resolved: [],
    ready: true,
  };
}

async function observeARecord(domain: string, target: string): Promise<DnsReadiness> {
  if (!domain || !target) return notApplicable("No public HTTP DNS record is required", domain);
  if (domain.endsWith(".nip.io")) {
    return notApplicable("nip.io resolves automatically; no DNS record needs to be created", domain);
  }

  let resolved: string[] = [];
  try {
    resolved = Array.from(new Set(await resolve4(domain))).sort();
  } catch {
    // An absent/unpropagated record and a temporary resolver failure are both
    // operator-observable pending states. OCD never writes to a DNS provider.
  }

  const exact = resolved.length === 1 && resolved[0] === target;
  const status: DnsInstructionStatus = exact
    ? "correct"
    : resolved.length === 0
      ? "pending"
      : "conflicting";
  const message = status === "correct"
    ? `${domain} resolves to ${target}`
    : status === "pending"
      ? `Create this record with your DNS provider; no A record is currently observed`
      : `${domain} resolves to ${resolved.join(", ")}; replace it with ${target}`;

  return {
    status,
    record: { type: "A", name: domain, value: target },
    observedValues: resolved,
    message,
    domain,
    expectedTarget: target,
    resolved,
    ready: exact,
  };
}

/**
 * Return provider-neutral DNS guidance for a public HTTP app. This controller
 * only performs recursive A-record lookups; it has no provider dependency and
 * cannot create, replace, or delete DNS records.
 */
export async function reconcileAppDns(
  appId: number,
  options: ReconcileOptions = {},
): Promise<DnsReadiness> {
  const keys = [`app:${appId}`];
  let acquired = false;
  if (!options.alreadyLocked) {
    const lock = tryAcquire(keys, NON_OP_HOLDER, "observe:dns");
    if (!lock.ok) {
      const app = db.getApp(appId);
      const message = `DNS observation deferred: ${lock.busyKey} is held by ${lock.heldBy.kind}`;
      if (options.skipIfBusy) {
        return {
          ...notApplicable(message, app?.domain || ""),
          ready: false,
        };
      }
      throw new Error(message);
    }
    acquired = true;
  }

  try {
    const app = db.getApp(appId);
    if (!app) throw new Error(`App ${appId} not found`);
    if (app.deletion_requested_at || !app.public || !app.domain) {
      const result = notApplicable(
        app.deletion_requested_at
          ? "The app is being removed; delete its DNS record manually if it is no longer needed"
          : "Private and raw-only apps do not require a DNS instruction",
        app.domain || "",
      );
      db.updateAppPublicEndpointStatus(app.id, "not_applicable");
      return result;
    }

    const target = getPanelIngressIpv4() || "";
    if (!target) {
      const message = "Panel ingress IPv4 is unavailable";
      db.updateAppPublicEndpointStatus(app.id, "degraded", message);
      return {
        ...notApplicable(message, app.domain),
        ready: false,
      };
    }

    const result = await observeARecord(app.domain, target);
    const error = result.ready ? "" : result.message;
    db.updateAppPublicEndpointStatus(app.id, result.ready ? "ready" : "degraded", error);
    return result;
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
      catch (err) { console.warn(`[dns:observe] app ${app.id}: ${err}`); }
    }
  });
  await Promise.all(workers);
}

export async function reconcilePanelDns(): Promise<DnsReadiness> {
  const panel = db.getPanel();
  if (!panel) return notApplicable("The panel has not been deployed");
  const server = db.getServer(panel.server_id);
  if (!server?.ipv4 || !panel.domain || panel.domain.endsWith(".nip.io")) {
    return notApplicable(
      panel.domain.endsWith(".nip.io")
        ? "nip.io resolves automatically; no DNS record needs to be created"
        : "The panel does not yet have a public DNS target",
      panel.domain,
    );
  }
  return observeARecord(panel.domain, server.ipv4);
}

export async function reconcileServiceDns(serviceId: number): Promise<DnsReadiness> {
  const service = db.getService(serviceId);
  if (!service) throw new Error(`Service ${serviceId} not found`);
  const catalog = getCatalogEntry(service.service_type);
  let domain = "";
  try { domain = String(JSON.parse(service.credentials || "{}")?.domain || ""); }
  catch { /* malformed credentials are not a public endpoint */ }
  if (!catalog?.http || !domain) {
    return notApplicable("Private and raw-only services do not require a DNS instruction", domain);
  }
  const target = getPanelIngressIpv4() || "";
  if (!target) return { ...notApplicable("Panel ingress IPv4 is unavailable", domain), ready: false };
  return observeARecord(domain, target);
}

export type PublicEndpointReadiness = DnsReadiness & {
  tlsReady: boolean;
  httpStatus?: number;
  tlsError?: string;
};

export async function validatePublicEndpoint(appId: number): Promise<PublicEndpointReadiness> {
  const dns = await reconcileAppDns(appId);
  if (!dns.ready) return { ...dns, tlsReady: false, tlsError: dns.message };
  const app = db.getApp(appId)!;
  if (app.domain.endsWith(".nip.io")) return { ...dns, tlsReady: true };
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
