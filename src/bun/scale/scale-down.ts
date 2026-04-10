import * as db from "../db.ts";
import * as hetzner from "../hetzner/index.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";
import { rebindContainer } from "./rebind.ts";

export async function scaleDown(
  app: App,
  currentReplicas: Replica[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn
) {
  const lbId = app.hetzner_lb_id;

  // Sort: prefer unhealthy first, then newest
  const sorted = [...currentReplicas].sort((a, b) => {
    if (a.status !== "running" && b.status === "running") return -1;
    if (a.status === "running" && b.status !== "running") return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const toRemove = sorted.slice(0, currentCount - targetCount);

  let removedCount = 0;
  for (const replica of toRemove) {
    try {
      emit("scale", `Draining replica ${replica.container_name}...`);

      const server = db.getServer(replica.server_id);
      if (!server) continue;
      const hostKey = server.ssh_host_key || undefined;

      // Remove from LB
      if (lbId) {
        try {
          await hetzner.removeLBTarget(lbId, server.hetzner_id);
        } catch (err) {
          log("scale", `Failed to remove LB target (continuing): ${err}`);
        }
      }

      // Drain period
      db.updateReplicaStatus(replica.id, "draining");
      emit("scale", `Waiting 10s drain for ${replica.container_name}...`);
      await Bun.sleep(10_000);

      // Stop and remove container
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
      if (app.deploy_mode === "compose" && replica.container_name === app.name) {
        // This is the primary compose instance — handled separately during 2→1
      } else {
        await hetzner.sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
      }

      // Remove auth proxy if present
      if (app.auth_password) {
        try {
          await hetzner.removeAuthProxy(server.ipv4, replica.container_name, hostKey);
        } catch (err) {
          log("scale", `Failed to remove auth proxy for ${replica.container_name}: ${err}`);
        }
      }

      db.deleteReplica(replica.id);
      removedCount++;
      emit("scale", `Replica ${replica.container_name} removed`);
    } catch (err) {
      log("scale", `Failed to remove replica ${replica.container_name}: ${err}`);
      // Stop attempting further removals — don't make things worse
      break;
    }
  }

  if (removedCount < toRemove.length) {
    const actualCount = currentCount - removedCount;
    db.updateAppScaling(app.id, { desired_replicas: actualCount });
    throw new Error(`Scale-down incomplete — only removed ${removedCount} of ${toRemove.length} replicas. Some servers may need manual cleanup.`);
  }

  // If going to 0, deploy wake page so HTTP requests auto-wake the app.
  if (targetCount === 0) {
    const lastRemoved = toRemove[toRemove.length - 1];
    const lastServer = db.getServer(lastRemoved.server_id);
    if (lastServer) {
      const wakeToken = crypto.randomUUID();
      db.updateAppSleepingState(app.id, lastServer.id, lastRemoved.host_port, wakeToken);
      const panel = db.getPanel();
      const panelDomain = panel?.domain || "";
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      await hetzner.deployCaddyWakePage(
        lastServer.ipv4, app.domain, panelDomain, app.id, wakeToken, useInternalTls,
        lastServer.ssh_host_key || undefined
      );
    }
    db.updateAppStatus(app.id, "sleeping");
    emit("scale", "App scaled to zero — sleeping");
  }

  // Tear down LB when going to 1 or 0 replicas.
  if (targetCount <= 1 && lbId) {
    emit("scale", "Removing load balancer...");

    // When going to 1, rebind the surviving container back to localhost + Caddy
    if (targetCount === 1) {
      const survivors = db.getReplicas(app.id);
      const survivor = survivors[0];
      if (!survivor) throw new Error("No surviving replica after scale-down");
      const primaryServer = db.getServer(survivor.server_id);
      if (!primaryServer) throw new Error("Surviving replica's server not found");
      const primaryHostPort = survivor.host_port;
      const primaryHostKey = primaryServer.ssh_host_key || undefined;

      // Re-bind container back to 127.0.0.1
      await rebindContainer(primaryServer.ipv4, app, "127.0.0.1", primaryHostPort, primaryHostKey);

      // Restore Caddy
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      const caddyPort = app.auth_password ? hetzner.authProxyPort(primaryHostPort) : primaryHostPort;
      await hetzner.deployCaddySite(primaryServer.ipv4, app.domain, caddyPort, useInternalTls, primaryHostKey);

      // Atomic DNS swap: create new record first, then delete old (overlap, not gap)
      const dnsRecords = db.getDnsRecords(app.id);
      const settings = db.getSettings();
      if (dnsRecords.length > 0 && settings.dns_zone_id) {
        const parts = app.domain.split(".");
        const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
        const newRecord = await hetzner.createDnsRecord({
          zone_id: settings.dns_zone_id,
          name: subdomain,
          type: "A",
          value: primaryServer.ipv4,
        });
        db.insertDnsRecord({
          app_id: app.id,
          zone_id: settings.dns_zone_id,
          record_id: newRecord.id,
          name: subdomain,
          type: "A",
          value: primaryServer.ipv4,
        });
        for (const record of dnsRecords) {
          try {
            await hetzner.deleteDnsRecord({
              zone_id: record.zone_id,
              name: record.name,
              type: record.type,
              value: record.value,
            });
            db.deleteDnsRecord(record.record_id);
          } catch (err) {
            log("scale", `Failed to delete old DNS record ${record.record_id}: ${err}`);
          }
        }
      }
    }

    // When going to 0, DNS should point to the sleeping server (wake page is already deployed)
    if (targetCount === 0) {
      const sleepingApp = db.getApp(app.id);
      const sleepingServer = sleepingApp?.sleeping_server_id ? db.getServer(sleepingApp.sleeping_server_id) : null;
      if (sleepingServer) {
        const dnsRecords = db.getDnsRecords(app.id);
        const settings = db.getSettings();
        if (dnsRecords.length > 0 && settings.dns_zone_id) {
          const parts = app.domain.split(".");
          const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
          const newRecord = await hetzner.createDnsRecord({
            zone_id: settings.dns_zone_id,
            name: subdomain,
            type: "A",
            value: sleepingServer.ipv4,
          });
          db.insertDnsRecord({
            app_id: app.id,
            zone_id: settings.dns_zone_id,
            record_id: newRecord.id,
            name: subdomain,
            type: "A",
            value: sleepingServer.ipv4,
          });
          for (const record of dnsRecords) {
            try {
              await hetzner.deleteDnsRecord({
                zone_id: record.zone_id,
                name: record.name,
                type: record.type,
                value: record.value,
              });
              db.deleteDnsRecord(record.record_id);
            } catch (err) {
              log("scale", `Failed to delete old DNS record ${record.record_id}: ${err}`);
            }
          }
        }
      }
    }

    // Delete LB (may already be gone if deleted externally)
    const lb = await hetzner.getLoadBalancer(lbId).catch(() => null);
    if (lb) {
      await hetzner.deleteLoadBalancer(lbId);
      // Remove LB firewall rules — use any known host port for the firewall rule
      try {
        const firewallId = await hetzner.ensureFirewall();
        const anyHostPort = toRemove[0]?.host_port || 0;
        const destPort = app.auth_password ? hetzner.authProxyPort(anyHostPort) : anyHostPort;
        if (destPort) {
          await hetzner.removeLBFirewallRule(firewallId, destPort, lb.public_net.ipv4.ip);
        }
      } catch (err) {
        log("scale", `Failed to remove LB firewall rule: ${err}`);
      }
    }
    db.updateAppScaling(app.id, { hetzner_lb_id: "" });

    emit("scale", "Load balancer removed");
  }

  // GC every affected server uniformly — gcServerIfEmpty handles the
  // empty/panel checks. No primary exemption.
  const candidateServerIds = new Set<number>();
  for (const replica of toRemove) {
    candidateServerIds.add(replica.server_id);
  }
  for (const serverId of candidateServerIds) {
    try {
      const before = db.getServer(serverId);
      await db.gcServerIfEmpty(serverId);
      const after = db.getServer(serverId);
      if (before && !after) emit("scale", `Server ${before.name} deleted`);
    } catch (err) {
      log("scale", `Failed to gc server ${serverId}: ${err}`);
    }
  }
}
