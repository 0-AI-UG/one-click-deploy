import { hetznerDns } from "./api.ts";

export async function createDnsRecord(opts: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
}) {
  const data = await hetznerDns("/records", {
    method: "POST",
    body: JSON.stringify({
      zone_id: opts.zone_id,
      name: opts.name,
      type: opts.type,
      value: opts.value,
      ttl: opts.ttl ?? 300,
    }),
  });
  return data.record;
}

export async function deleteDnsRecord(recordId: string) {
  await hetznerDns(`/records/${recordId}`, { method: "DELETE" });
}

export async function listDnsZones() {
  const data = await hetznerDns("/zones");
  return data.zones;
}
