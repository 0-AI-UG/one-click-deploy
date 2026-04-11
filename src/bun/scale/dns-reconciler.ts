import * as db from "../db.ts";
import { getDnsProvider } from "../providers/index.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [dns-recon:${context}]`, ...args);
}

/**
 * Post-migration DNS swing: every app's public A record should point at the
 * single panel server's public IPv4, since the panel's Caddy is now the only
 * public ingress. Apps whose records still point at the old per-tenant
 * server's public IP get create-new → delete-old'd record by record.
 *
 * Runs on every reconciler tick. Idempotent by construction — once all A
 * records for every app match panel_ipv4 the pass is a tight no-op: one DB
 * read per app, zero provider calls.
 *
 * Failures never throw — DNS is recoverable and we don't want a flaky provider
 * wrecking the tick. Swing attempts are retried naturally on the next pass.
 */
export async function reconcileAppDns(): Promise<void> {
  const panel = db.getPanel();
  const panelServer = panel ? db.getServer(panel.server_id) : null;
  if (!panelServer || !panelServer.ipv4) {
    // No panel yet, or panel server has no public IP. Without a target
    // address there's nothing we can swing records to.
    return;
  }

  const settings = db.getSettings();
  const zoneId = settings.dns_zone_id;
  if (!zoneId) {
    // No DNS zone configured — this install manages DNS out-of-band and we
    // must not touch records we didn't create.
    return;
  }

  const dns = getDnsProvider();
  const targetIp = panelServer.ipv4;

  for (const app of db.getApps()) {
    // Skip apps without a real public domain. nip.io domains encode the IP
    // directly — they would never resolve correctly through the panel, and
    // we don't track DNS records for them anyway.
    if (!app.domain || app.domain.endsWith(".nip.io")) continue;

    const records = db.getDnsRecords(app.id).filter((r) => r.type === "A");
    if (records.length === 0) continue;

    for (const record of records) {
      if (record.value === targetIp) continue; // already pointing at panel

      let created;
      try {
        created = await dns.createRecord({
          zoneId: record.zone_id,
          name: record.name,
          type: "A",
          value: targetIp,
        });
      } catch (err) {
        // Create failed (quota, transient API error, DNS already has a
        // record with this exact value-tuple). Log and move on — the next
        // tick retries. We do NOT touch the stale record until the
        // replacement is confirmed, so public traffic keeps flowing.
        log("swing", `create failed for ${record.name} -> ${targetIp}: ${err}`);
        continue;
      }

      db.insertDnsRecord({
        app_id: app.id,
        zone_id: record.zone_id,
        record_id: created.id,
        name: record.name,
        type: "A",
        value: targetIp,
      });

      // Best-effort delete of the stale upstream record. If the provider
      // 404s because the record is already gone (manual cleanup, race with
      // another tick), we still want to purge the DB row so this pass
      // stops selecting it.
      try {
        await dns.deleteRecord({
          zoneId: record.zone_id,
          name: record.name,
          type: record.type,
          value: record.value,
        });
      } catch (err) {
        log(
          "swing",
          `upstream delete of stale ${record.name}=${record.value} failed (continuing): ${err}`,
        );
      }
      db.deleteDnsRecord(record.record_id);

      log("swing", `swung ${app.domain} -> panel ${targetIp}`);
    }
  }
}
