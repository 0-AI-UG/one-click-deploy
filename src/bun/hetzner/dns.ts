import { hetznerApi } from "./api.ts";

// DNS is now part of the unified Hetzner Cloud API (api.hetzner.cloud/v1/zones).
// Records are grouped into RRSets keyed by (zone, name, type); a single value
// is added/removed via the rrset actions endpoints.

function rrsetPath(zoneId: string, name: string, type: string): string {
  return `/zones/${encodeURIComponent(zoneId)}/rrsets/${encodeURIComponent(name)}/${encodeURIComponent(type)}`;
}

export async function createDnsRecord(opts: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
}): Promise<{ id: string; name: string; type: string; value: string }> {
  const body: any = {
    name: opts.name,
    type: opts.type,
    records: [{ value: opts.value }],
  };
  if (opts.ttl != null) body.ttl = opts.ttl;

  const postRrset = () =>
    hetznerApi(`/zones/${encodeURIComponent(opts.zone_id)}/rrsets`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  try {
    await postRrset();
  } catch (err: any) {
    // RRSet already exists. For OCD's use case an app "owns" its (name,type)
    // rrset and should resolve to a single IP — replace any existing values
    // instead of appending. Appending caused apex deploys to round-robin
    // between the new OCD server and stale values (e.g. an old hoster's IP),
    // which broke Let's Encrypt validation and served the wrong backend.
    const msg = String(err?.message || "");
    if (/already exists|uniqueness|conflict/i.test(msg)) {
      await hetznerApi(rrsetPath(opts.zone_id, opts.name, opts.type), {
        method: "DELETE",
      }).catch(() => { /* ignore if the record vanished between calls */ });
      await postRrset();
    } else {
      throw err;
    }
  }

  // Synthetic id — the new API has no per-record id; we identify records by
  // (zone, name, type, value) and persist all four in dns_records.
  return {
    id: `${opts.name}/${opts.type}/${opts.value}`,
    name: opts.name,
    type: opts.type,
    value: opts.value,
  };
}

export async function deleteDnsRecord(opts: {
  zone_id: string;
  name: string;
  type: string;
  value: string;
}) {
  try {
    await hetznerApi(`${rrsetPath(opts.zone_id, opts.name, opts.type)}/actions/remove_records`, {
      method: "POST",
      body: JSON.stringify({ records: [{ value: opts.value }] }),
    });
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (/not found/i.test(msg)) return;
    throw err;
  }
}

export async function listDnsZones() {
  const data = await hetznerApi("/zones");
  return data.zones;
}
