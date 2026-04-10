import { resolve4 } from "node:dns/promises";
import * as hetzner from "../hetzner/index.ts";
import * as db from "../db.ts";
import type { DeployState } from "./rollback.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [deploy:${context}]`, ...args);
}

export async function resolveDomainIps(domain: string, timeoutMs = 3000): Promise<string[]> {
  try {
    return await Promise.race([
      resolve4(domain),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
    ]);
  } catch {
    return [];
  }
}

export async function setupDns(
  req: { domain?: string; app_name: string },
  serverIp: string,
  dnsZoneId: string | undefined,
  state: DeployState,
  onProgress: ProgressFn,
): Promise<{ useDomain: string; useInternalTls: boolean }> {
  const useDomain = req.domain || `${req.app_name}.${serverIp}.nip.io`;
  const useInternalTls = !req.domain;
  log("dns", `Domain: ${useDomain} (internal TLS: ${useInternalTls})`);

  onProgress("dns", req.domain ? `Creating DNS record for ${req.domain}...` : `Using ${useDomain} (no custom domain)`);

  const parts = useDomain.split(".");
  const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

  if (req.domain && dnsZoneId) {
    try {
      log("dns", `Creating DNS A record: ${subdomain} -> ${serverIp} in zone ${dnsZoneId}`);
      const record = await hetzner.createDnsRecord({
        zone_id: dnsZoneId,
        name: subdomain,
        type: "A",
        value: serverIp,
      });
      state.dnsRecord = { zone_id: dnsZoneId, name: subdomain, type: "A", value: serverIp };
      log("dns", `DNS record created: ${record.id}`);
      onProgress("dns", `DNS A record created: ${req.domain} -> ${serverIp}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("dns", `DNS record creation failed: ${msg}`);
      onProgress("dns", `DNS failed (continuing): ${msg}`);
    }
  } else if (req.domain) {
    onProgress("dns", "No DNS zone configured, skipping DNS record");
  } else {
    onProgress("dns", `Will use ${useDomain}`);
  }

  return { useDomain, useInternalTls };
}

export async function verifyDnsForCaddy(
  domain: string,
  serverIp: string,
  onProgress: ProgressFn,
): Promise<void> {
  onProgress("caddy", `Verifying DNS for ${domain}...`);
  const resolved = await resolveDomainIps(domain);
  if (resolved.length === 0) {
    throw new Error(
      `DNS lookup for ${domain} returned no A records. Create an A record pointing to ${serverIp} and retry (DNS can take a few minutes to propagate).`
    );
  }
  if (!resolved.includes(serverIp)) {
    throw new Error(
      `Domain ${domain} resolves to ${resolved.join(", ")} but this server is ${serverIp}. Update the A record to ${serverIp} (Let's Encrypt will fail to issue a certificate otherwise) and retry.`
    );
  }
  onProgress("caddy", `DNS OK: ${domain} -> ${serverIp}`);
}

export function persistDnsRecord(appId: number, dnsRecord: NonNullable<DeployState["dnsRecord"]>): void {
  db.insertDnsRecord({
    app_id: appId,
    zone_id: dnsRecord.zone_id,
    record_id: `${dnsRecord.name}/${dnsRecord.type}/${dnsRecord.value}`,
    name: dnsRecord.name,
    type: dnsRecord.type,
    value: dnsRecord.value,
  });
}
