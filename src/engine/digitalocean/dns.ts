import { doApi } from "./api.ts";

// DigitalOcean DNS lives in /v2/domains. Each domain is one zone; records are
// keyed by numeric id. Like the Hetzner-DNS provider, OCD treats (name,type)
// as ownership — replacing existing values rather than appending.

type DoDomain = { name: string; ttl?: number };
type DoDomainRecord = {
  id: number;
  type: string;
  name: string;
  data: string;
  ttl?: number;
};

function fqdnToHost(zone: string, fqdn: string): string {
  // DO record `name` is relative to the zone (e.g., "@" for apex, "www" for www.example.com).
  const lower = fqdn.toLowerCase().replace(/\.$/, "");
  const z = zone.toLowerCase().replace(/\.$/, "");
  if (lower === z) return "@";
  if (lower.endsWith("." + z)) return lower.slice(0, -1 * (z.length + 1));
  return lower;
}

export async function listDoDnsZones(): Promise<Array<{ id: string; name: string }>> {
  const data = await doApi("/domains?per_page=200") as { domains: DoDomain[] };
  return (data.domains ?? []).map((d) => ({ id: d.name, name: d.name }));
}

async function findRecords(zone: string, name: string, type: string): Promise<DoDomainRecord[]> {
  const host = fqdnToHost(zone, name);
  // /v2/domains/{name}/records?name=&type= filters server-side (DO supports both).
  const data = await doApi(
    `/domains/${encodeURIComponent(zone)}/records?name=${encodeURIComponent(host === "@" ? zone : `${host}.${zone}`)}&type=${encodeURIComponent(type)}&per_page=200`,
  ) as { domain_records: DoDomainRecord[] };
  return data.domain_records ?? [];
}

export async function createDoDnsRecord(opts: {
  zone_id: string; // DO uses the domain name as the zone id
  name: string;
  type: string;
  value: string;
  ttl?: number;
}): Promise<{ id: string; name: string; type: string; value: string }> {
  const zone = opts.zone_id;
  const host = fqdnToHost(zone, opts.name);

  // OCD-owned (name,type) — wipe existing values to avoid round-robin to stale IPs.
  const existing = await findRecords(zone, opts.name, opts.type);
  for (const r of existing) {
    await doApi(`/domains/${encodeURIComponent(zone)}/records/${r.id}`, { method: "DELETE" })
      .catch(() => { /* ignore */ });
  }

  const body: Record<string, unknown> = {
    type: opts.type,
    name: host,
    data: opts.value,
  };
  if (opts.ttl != null) body.ttl = opts.ttl;
  const data = await doApi(`/domains/${encodeURIComponent(zone)}/records`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as { domain_record: DoDomainRecord };

  return {
    id: String(data.domain_record.id),
    name: opts.name,
    type: opts.type,
    value: opts.value,
  };
}

export async function deleteDoDnsRecord(opts: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
}): Promise<void> {
  const records = await findRecords(opts.zone_id, opts.name, opts.type);
  const match = records.find((r) => r.data === opts.value);
  if (!match) return;
  await doApi(`/domains/${encodeURIComponent(opts.zone_id)}/records/${match.id}`, { method: "DELETE" })
    .catch((err) => {
      if (/not found/i.test(err?.message ?? "")) return;
      throw err;
    });
}
