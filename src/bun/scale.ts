import * as db from "./db.ts";
import * as hetzner from "./hetzner/index.ts";
import { resolveGitHubToken } from "./github-token.ts";

type ProgressFn = (step: string, detail: string) => void;

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [scale:${context}]`, ...args);
}

// In-memory tracker: when each app first entered sustained idle state.
// Cleared when metrics rise above idle thresholds or app scales.
const idleSince = new Map<number, number>();

/**
 * Core scaling function: adjusts an app to the target replica count.
 * Handles LB creation/deletion, image transfer, container lifecycle.
 */
export async function scaleApp(
  appId: number,
  targetReplicas: number,
  onProgress?: ProgressFn,
  targetServerId?: number
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});
  log("scale", `Scaling app ${appId} to ${targetReplicas} replicas`);

  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const currentReplicas = db.getReplicas(appId);
    const currentCount = currentReplicas.length;

    if (targetReplicas === currentCount) {
      return { ok: true };
    }

    if (targetReplicas < 0) {
      return { ok: false, error: "Replicas cannot be negative" };
    }

    if (targetReplicas > currentCount) {
      try {
        await scaleUp(app, currentReplicas, currentCount, targetReplicas, emit, targetServerId);
      } catch (err) {
        // Rollback: clean up any resources created during failed scale-up
        emit("scale", "Scale-up failed, rolling back...");
        await rollbackScaleUp(app, currentReplicas, emit);
        throw err;
      }
    } else {
      await scaleDown(app, currentReplicas, currentCount, targetReplicas, emit);
    }

    db.updateAppScaling(appId, {
      desired_replicas: targetReplicas,
      last_scale_at: new Date().toISOString(),
    });

    db.insertScalingEvent({
      app_id: appId,
      event_type: targetReplicas > currentCount ? "scale_up" : "scale_down",
      from_count: currentCount,
      to_count: targetReplicas,
      reason: "manual",
    });

    log("scale", `App ${appId} scaled from ${currentCount} to ${targetReplicas}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("scale", `Failed to scale app ${appId}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function scaleUp(
  app: any,
  currentReplicas: any[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn,
  targetServerId?: number
) {
  const settings = db.getSettings();
  const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
  // The "primary" is just whichever server hosts the first (oldest) replica.
  const firstReplica = currentReplicas[0];
  const primaryServer = db.getServer(firstReplica.server_id);
  if (!primaryServer) throw new Error("First replica's server not found");
  const primaryHostPort = firstReplica.host_port;

  // Validate that stored LB still exists (may have been deleted externally)
  if (app.hetzner_lb_id) {
    const lb = await hetzner.getLoadBalancer(app.hetzner_lb_id).catch(() => null);
    if (!lb) {
      log("scale", `Load balancer ${app.hetzner_lb_id} not found, will re-create`);
      db.updateAppScaling(app.id, { hetzner_lb_id: "" });
      app = { ...app, hetzner_lb_id: "" };
    }
  }

  // If going from 1 to N, set up LB
  if (currentCount === 1 && !app.hetzner_lb_id) {
    emit("scale", "Creating load balancer...");

    // Create LB
    const lb = await hetzner.createLoadBalancer(app.name, primaryServer.location);
    db.updateAppScaling(app.id, { hetzner_lb_id: String(lb.id) });

    // Create managed TLS certificate (only for real domains, not nip.io)
    let certId: number | undefined;
    if (app.domain && !app.domain.endsWith(".nip.io")) {
      emit("scale", "Creating TLS certificate...");
      try {
        const cert = await hetzner.createManagedCertificate(app.name, app.domain);
        certId = cert.id;
        // Wait a moment for cert to register
        await Bun.sleep(2000);
      } catch (err) {
        log("scale", `Certificate creation failed (will use HTTP): ${err}`);
      }
    }

    // Add LB service — uses HTTPS if cert available, HTTP otherwise
    const destPort = app.auth_password
      ? hetzner.authProxyPort(primaryHostPort)
      : primaryHostPort;
    await hetzner.addLBService(
      String(lb.id),
      destPort,
      certId,
      !!app.auth_password
    );

    // Atomic DNS swap: create new record first, then delete old (overlap, not gap)
    const dnsRecords = db.getDnsRecords(app.id);
    const dnsSettings = db.getSettings();
    if (dnsRecords.length > 0 && dnsSettings.dns_zone_id) {
      const parts = app.domain.split(".");
      const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
      // Create new record pointing to LB first
      const newRecord = await hetzner.createDnsRecord({
        zone_id: dnsSettings.dns_zone_id,
        name: subdomain,
        type: "A",
        value: lb.ipv4,
      });
      db.insertDnsRecord({
        app_id: app.id,
        zone_id: dnsSettings.dns_zone_id,
        record_id: newRecord.id,
        name: subdomain,
        type: "A",
        value: lb.ipv4,
      });
      // Now safe to delete old records
      for (const record of dnsRecords) {
        try {
          await hetzner.deleteDnsRecord({
            zone_id: record.zone_id,
            name: record.name,
            type: record.type,
            value: record.value,
          });
          db.deleteDnsRecord(record.record_id);
        } catch (e) {
          log("dns", `Failed to delete old DNS record ${record.record_id}:`, e);
        }
      }
    }

    // Re-bind existing container to 0.0.0.0
    const bindAddr = "0.0.0.0";
    emit("scale", `Re-binding container to ${bindAddr}...`);
    const primaryHostKey = primaryServer.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

    if (app.deploy_mode === "compose") {
      // Update compose override to bind to bindAddr
      const overrideServices: any = {
        [app.compose_web_service]: {
          ports: [`${bindAddr}:${primaryHostPort}:${app.container_port}`],
        },
      };
      const override = JSON.stringify({ services: overrideServices });
      const overridePath = `/home/deploy/apps/${app.name}/docker-compose.ocd.yml`;
      const escapedOverride = override.replace(/'/g, "'\\''");
      await hetzner.sshExec(primaryServer.ipv4, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`, primaryHostKey);
      await hetzner.sshExec(primaryServer.ipv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`), primaryHostKey);
    } else {
      // Safe rebind: start temp container on new bind, verify, then swap
      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envEntries.length > 0) {
        const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
        envFileFlag = `--env-file ${envFilePath}`;
      }
      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const tempName = `${app.name}-rebind`;
      // Start new container with temp name on bindAddr
      const cmd = `docker run -d --name ${tempName} --restart unless-stopped -p ${bindAddr}:${primaryHostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
      const startResult = await hetzner.sshExec(primaryServer.ipv4, asUser(cmd), primaryHostKey);
      if (startResult.exitCode !== 0) {
        // Clean up temp container and rethrow
        await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${tempName} 2>/dev/null || true`), primaryHostKey);
        throw new Error(`Failed to restart container during scaling — check container logs for details`);
      }
      // New container is running — now safe to remove old and rename
      await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${app.name} 2>/dev/null || true`), primaryHostKey);
      await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rename ${tempName} ${app.name}`), primaryHostKey);
    }

    // Add firewall rule for LB access
    const firewallId = await hetzner.ensureFirewall();
    await hetzner.addLBFirewallRule(firewallId, destPort, lb.ipv4);

    // Add primary server as LB target
    await hetzner.addLBTarget(String(lb.id), primaryServer.hetzner_id);

    // Remove Caddy reverse proxy (LB handles TLS now)
    await hetzner.removeCaddySite(primaryServer.ipv4, app.domain, primaryHostKey);

    emit("scale", "Load balancer ready");
  }

  // Add new replicas
  const lbId = app.hetzner_lb_id;
  const lb = await hetzner.getLoadBalancer(lbId);
  const lbIpv4 = lb.public_net.ipv4.ip;

  for (let i = currentCount; i < targetCount; i++) {
    const replicaNum = i + 1;
    emit("scale", `Provisioning replica ${replicaNum}/${targetCount}...`);

    // Pick target server: user-specified, least-loaded existing, or newly provisioned
    let targetServer = await pickTargetServer(app, settings, emit, targetServerId);
    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Transfer image to target server
    emit("scale", `Transferring image to ${targetServer.name}...`);
    const imageName = `${app.name}:latest`;

    if (app.deploy_mode === "compose") {
      // For compose, clone repo and build on target
      await hetzner.cloneAndComposeBuild(
        targetServer.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort: db.nextReplicaHostPort(targetServer.id),
          envVars: JSON.parse(app.env_vars || "{}"),
          volumeMount: app.volume_mount || undefined,
          composeFile: app.compose_file,
          webService: app.compose_web_service,
          gitToken: githubPat,
        },
        (line) => emit("scale", line)
      );
    } else {
      await hetzner.transferImage(
        primaryServer.ipv4,
        targetServer.ipv4,
        imageName,
        primaryServer.ssh_host_key || undefined,
        targetHostKey
      );
    }

    // Allocate host port and start container
    const hostPort = db.nextReplicaHostPort(targetServer.id);
    const containerName = `${app.name}-r${replicaNum}`;

    if (app.deploy_mode !== "compose") {
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
      const envVars = JSON.parse(app.env_vars || "{}");
      const envEntries = Object.entries(envVars);
      let envFileFlag = "";
      if (envEntries.length > 0) {
        const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await hetzner.sshExec(targetServer.ipv4, `mkdir -p /home/deploy/apps/${app.name}`, targetHostKey);
        await hetzner.sshExec(targetServer.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, targetHostKey);
        envFileFlag = `--env-file ${envFilePath}`;
      }
      const replicaBindAddr = "0.0.0.0";
      const cmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${replicaBindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${imageName}`;
      const result = await hetzner.sshExec(targetServer.ipv4, asUser(cmd), targetHostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to start replica on target server — check that Docker is running and the image was transferred");
      }
    }

    // Deploy auth proxy on new server if needed
    if (app.auth_password) {
      await hetzner.deployAuthProxy(
        targetServer.ipv4,
        containerName,
        app.auth_password,
        hostPort,
        targetHostKey
      );
    }

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(targetServer.ipv4, app.name, hostPort, 5, targetHostKey)
      : await hetzner.healthCheck(targetServer.ipv4, containerName, hostPort, 5, targetHostKey);

    // Add LB target
    await hetzner.addLBTarget(lbId, targetServer.hetzner_id);

    // Add firewall rule
    const firewallId = await hetzner.ensureFirewall();
    const destPort = app.auth_password ? hetzner.authProxyPort(hostPort) : hostPort;
    await hetzner.addLBFirewallRule(firewallId, destPort, lbIpv4);

    // Insert replica record
    db.insertReplica({
      app_id: app.id,
      server_id: targetServer.id,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "running" : "unhealthy",
    });

    emit("scale", `Replica ${replicaNum} deployed on ${targetServer.name}`);
  }
}

async function scaleDown(
  app: any,
  currentReplicas: any[],
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
        } catch (e) {
          log("scale", `Failed to remove auth proxy for ${replica.container_name}:`, e);
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
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      if (app.deploy_mode === "compose") {
        const overrideServices: any = {
          [app.compose_web_service]: {
            ports: [`127.0.0.1:${primaryHostPort}:${app.container_port}`],
          },
        };
        const override = JSON.stringify({ services: overrideServices });
        const overridePath = `/home/deploy/apps/${app.name}/docker-compose.ocd.yml`;
        const escapedOverride = override.replace(/'/g, "'\\''");
        await hetzner.sshExec(primaryServer.ipv4, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`, primaryHostKey);
        await hetzner.sshExec(primaryServer.ipv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`), primaryHostKey);
      } else {
        // Safe rebind: start temp container on 127.0.0.1, verify, then swap
        const envVars = JSON.parse(app.env_vars || "{}");
        const envEntries = Object.entries(envVars);
        let envFileFlag = "";
        if (envEntries.length > 0) {
          envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
        }
        const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
        const tempName = `${app.name}-rebind`;
        const cmd = `docker run -d --name ${tempName} --restart unless-stopped -p 127.0.0.1:${primaryHostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
        const startResult = await hetzner.sshExec(primaryServer.ipv4, asUser(cmd), primaryHostKey);
        if (startResult.exitCode !== 0) {
          await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${tempName} 2>/dev/null || true`), primaryHostKey);
          throw new Error(`Failed to restart container during scaling — check container logs for details`);
        }
        await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${app.name} 2>/dev/null || true`), primaryHostKey);
        await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rename ${tempName} ${app.name}`), primaryHostKey);
      }

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
          } catch (e) {
            log("dns", `Failed to delete old DNS record ${record.record_id}:`, e);
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
            } catch (e) {
              log("dns", `Failed to delete old DNS record ${record.record_id}:`, e);
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
      } catch (e) {
        log("lb", "Failed to remove LB firewall rule:", e);
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

/**
 * Rollback after a failed scale-up: remove any newly created replicas,
 * delete LB if it was just created, delete any newly provisioned servers,
 * and restore the app to its pre-scale state (Caddy + 127.0.0.1 binding).
 */
async function rollbackScaleUp(
  app: any,
  originalReplicas: any[],
  emit: ProgressFn
): Promise<void> {
  const freshApp = db.getApp(app.id);
  if (!freshApp) return;
  // Determine the "primary" (where the original first replica lived).
  const firstReplica = originalReplicas[0];
  const primaryServer = firstReplica ? db.getServer(firstReplica.server_id) : null;
  const primaryHostPort = firstReplica?.host_port ?? 0;

  // Find replicas that were added (not in the original set)
  const originalIds = new Set(originalReplicas.map(r => r.id));
  const currentReplicas = db.getReplicas(app.id);
  const newReplicas = currentReplicas.filter(r => !originalIds.has(r.id));

  // Remove new replicas
  for (const replica of newReplicas) {
    const server = db.getServer(replica.server_id);
    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      try {
        await hetzner.sshExec(server.ipv4, `su - deploy -c "docker rm -f ${replica.container_name} 2>/dev/null || true"`, hostKey);
      } catch (e) {
        log("rollback", `Failed to remove container ${replica.container_name}:`, e);
      }
      if (app.auth_password) {
        try {
          await hetzner.removeAuthProxy(server.ipv4, replica.container_name, hostKey);
        } catch (e) {
          log("rollback", `Failed to remove auth proxy for ${replica.container_name}:`, e);
        }
      }
    }
    db.deleteReplica(replica.id);
  }

  // If LB was just created (wasn't there before), tear it down
  const lbId = freshApp.hetzner_lb_id;
  if (lbId && !app.hetzner_lb_id && primaryServer) {
    emit("scale", "Removing load balancer...");
    try { await hetzner.deleteLoadBalancer(lbId); } catch (e) {
      log("rollback", `Failed to delete LB ${lbId}: ${e}`);
    }
    db.updateAppScaling(app.id, { hetzner_lb_id: "" });

    // Restore container to 127.0.0.1 binding
    const primaryHostKey = primaryServer.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    try {
      if (app.deploy_mode === "compose") {
        const overrideServices: any = {
          [app.compose_web_service]: {
            ports: [`127.0.0.1:${primaryHostPort}:${app.container_port}`],
          },
        };
        const override = JSON.stringify({ services: overrideServices });
        const overridePath = `/home/deploy/apps/${app.name}/docker-compose.ocd.yml`;
        const escapedOverride = override.replace(/'/g, "'\\''");
        await hetzner.sshExec(primaryServer.ipv4, `echo '${escapedOverride}' > ${overridePath} && chown deploy:deploy ${overridePath}`, primaryHostKey);
        await hetzner.sshExec(primaryServer.ipv4, asUser(`cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`), primaryHostKey);
      } else {
        // Safe rebind: start temp container, verify, then swap
        const envVars = JSON.parse(app.env_vars || "{}");
        const envEntries = Object.entries(envVars);
        let envFileFlag = "";
        if (envEntries.length > 0) {
          envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
        }
        const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
        const tempName = `${app.name}-rebind`;
        const cmd = `docker run -d --name ${tempName} --restart unless-stopped -p 127.0.0.1:${primaryHostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
        const startResult = await hetzner.sshExec(primaryServer.ipv4, asUser(cmd), primaryHostKey);
        if (startResult.exitCode !== 0) {
          await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${tempName} 2>/dev/null || true`), primaryHostKey);
          throw new Error(`Failed to restart container during scaling — check container logs for details`);
        }
        await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rm -f ${app.name} 2>/dev/null || true`), primaryHostKey);
        await hetzner.sshExec(primaryServer.ipv4, asUser(`docker rename ${tempName} ${app.name}`), primaryHostKey);
      }
    } catch (e) {
      log("rollback", `Failed to restore container binding: ${e}`);
    }

    // Restore Caddy
    try {
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      const caddyPort = app.auth_password ? hetzner.authProxyPort(primaryHostPort) : primaryHostPort;
      await hetzner.deployCaddySite(primaryServer.ipv4, app.domain, caddyPort, useInternalTls, primaryHostKey);
    } catch (e) {
      log("rollback", `Failed to restore Caddy: ${e}`);
    }
  }

  // GC any servers touched by the failed scale-up. gcServerIfEmpty handles
  // the empty/panel checks (the panel and any server still in use is exempt).
  const touched = new Set<number>();
  for (const r of newReplicas) touched.add(r.server_id);
  for (const serverId of touched) {
    try {
      await db.gcServerIfEmpty(serverId);
    } catch (e) {
      log("rollback", `Failed to gc server ${serverId}: ${e}`);
    }
  }

  emit("scale", "Rollback complete");
  log("rollback", `Scale-up rollback complete for app ${app.id}`);
}

async function pickTargetServer(
  app: any,
  settings: Record<string, string>,
  emit: ProgressFn,
  preferredServerId?: number
): Promise<any> {
  // Explicit placement: caller chose a specific server
  if (preferredServerId) {
    const preferred = db.getServer(preferredServerId);
    if (!preferred) throw new Error(`Target server ${preferredServerId} not found`);
    if (preferred.status !== "ready") throw new Error(`Target server ${preferred.name} is not ready (status: ${preferred.status})`);
    emit("scale", `Placing replica on ${preferred.name} (user-selected)`);
    return preferred;
  }

  // Find servers with fewest replicas of this app
  const allServers = db.getServers();
  const appReplicas = db.getReplicas(app.id);
  const replicasByServer = new Map<number, number>();
  for (const r of appReplicas) {
    replicasByServer.set(r.server_id, (replicasByServer.get(r.server_id) || 0) + 1);
  }

  // Find server with fewest replicas (prefer existing servers with 0 replicas of this app)
  let bestServer: any = null;
  let bestCount = Infinity;
  for (const server of allServers) {
    if (server.status !== "ready") continue;
    const count = replicasByServer.get(server.id) || 0;
    if (count < bestCount) {
      bestCount = count;
      bestServer = server;
    }
  }

  // If no server has room, or all servers already have replicas, provision new
  if (!bestServer || bestCount > 0) {
    emit("scale", "Provisioning new server for replica...");

    const [sshKey, firewallId] = await Promise.all([
      hetzner.ensureSshKey("one-click-deploy"),
      hetzner.ensureFirewall(),
    ]);

    const serverType = settings.default_server_type;
    if (!serverType) throw new Error("No default server type configured — set one in Settings");
    // Default location: any existing replica's server, else configured default.
    const replicas = db.getReplicas(app.id);
    const anyReplicaServer = replicas[0] ? db.getServer(replicas[0].server_id) : null;
    const location = anyReplicaServer?.location || settings.default_location;
    const serverName = `ocd-${app.name}-r${Date.now()}`;

    const hServer = await hetzner.createServer({
      name: serverName,
      server_type: serverType,
      location,
      ssh_key_name: sshKey.name,
      firewall_id: firewallId,
    });

    const serverIp = hServer.public_net.ipv4.ip;
    const dbServer = db.insertServer({
      name: serverName,
      hetzner_id: String(hServer.id),
      ipv4: serverIp,
      ipv6: hServer.public_net.ipv6.ip || "",
      type: serverType,
      location,
      status: "provisioning",
    });

    emit("scale", `Waiting for server ${serverName}...`);
    await hetzner.waitForServer(serverIp, 30, (msg) => emit("scale", msg));

    const hostKey = await hetzner.captureHostKey(serverIp);
    if (hostKey) {
      db.updateServerHostKey(dbServer.id, hostKey);
    }

    db.updateServerStatus(dbServer.id, "ready");
    emit("scale", `Server ${serverName} ready`);
    return db.getServer(dbServer.id);
  }

  return bestServer;
}

/**
 * Collect metrics from all replicas of an app via docker stats.
 */
export async function collectMetrics(appId: number): Promise<void> {
  const replicas = db.getReplicas(appId);

  for (const replica of replicas) {
    const server = db.getServer(replica.server_id);
    if (!server) continue;

    try {
      const hostKey = server.ssh_host_key || undefined;
      const result = await hetzner.sshExec(
        server.ipv4,
        `su - deploy -c "docker stats --no-stream --format '{{json .}}' ${replica.container_name} 2>/dev/null"`,
        hostKey
      );

      if (result.exitCode === 0 && result.stdout.trim()) {
        const stats = JSON.parse(result.stdout.trim());
        const cpuPercent = parseFloat(stats.CPUPerc?.replace("%", "") || "0");
        const memPercent = parseFloat(stats.MemPerc?.replace("%", "") || "0");
        db.updateReplicaMetrics(replica.id, cpuPercent, memPercent);
      }
    } catch (err) {
      log("metrics", `Failed to collect metrics for ${replica.container_name}: ${err}`);
    }
  }
}

/**
 * Evaluate autoscale policy and trigger scale up/down if needed.
 */
export async function evaluateAutoScale(appId: number): Promise<void> {
  const app = db.getApp(appId);
  if (!app || !app.autoscale_enabled) return;

  const replicas = db.getReplicas(appId);
  if (replicas.length === 0) return;

  // Check cooldown
  if (app.last_scale_at) {
    const elapsed = (Date.now() - new Date(app.last_scale_at).getTime()) / 1000;
    if (elapsed < app.autoscale_cooldown) {
      log("autoscale", `Cooldown active for app ${appId} (${Math.round(app.autoscale_cooldown - elapsed)}s remaining)`);
      return;
    }
  }

  const avgCpu = replicas.reduce((sum, r) => sum + r.cpu_percent, 0) / replicas.length;
  const avgMem = replicas.reduce((sum, r) => sum + r.memory_percent, 0) / replicas.length;

  log("autoscale", `App ${appId}: avgCPU=${avgCpu.toFixed(1)}% avgMem=${avgMem.toFixed(1)}% replicas=${replicas.length} min=${app.min_replicas} max=${app.max_replicas}`);

  // Scale up
  if (
    (avgCpu > app.autoscale_cpu_threshold || avgMem > app.autoscale_mem_threshold) &&
    replicas.length < app.max_replicas
  ) {
    log("autoscale", `Scaling up app ${appId}: CPU=${avgCpu.toFixed(1)}% > ${app.autoscale_cpu_threshold}% or MEM=${avgMem.toFixed(1)}% > ${app.autoscale_mem_threshold}%`);
    const result = await scaleApp(appId, replicas.length + 1);
    if (result.ok) {
      db.insertScalingEvent({
        app_id: appId,
        event_type: "autoscale_up",
        from_count: replicas.length,
        to_count: replicas.length + 1,
        reason: `CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}% exceeded thresholds`,
      });
    }
    return;
  }

  // Scale down
  const isIdle = avgCpu < app.autoscale_cpu_threshold * 0.5 &&
    avgMem < app.autoscale_mem_threshold * 0.5;

  if (!isIdle) {
    // Metrics are not idle — clear any tracked idle start
    idleSince.delete(appId);
    return;
  }

  if (replicas.length > app.min_replicas) {
    // Scale-to-zero requires sustained idle for scale_to_zero_after seconds
    if (replicas.length === 1 && app.min_replicas === 0) {
      const idleTimeout = app.scale_to_zero_after ?? 300;
      const now = Date.now();
      if (!idleSince.has(appId)) {
        idleSince.set(appId, now);
        log("autoscale", `App ${appId}: idle detected, will sleep after ${idleTimeout}s of sustained idle`);
        return;
      }
      const idleDuration = (now - idleSince.get(appId)!) / 1000;
      if (idleDuration < idleTimeout) {
        log("autoscale", `App ${appId}: idle for ${Math.round(idleDuration)}s / ${idleTimeout}s before sleep`);
        return;
      }
      // Sustained idle confirmed — scale to zero
      idleSince.delete(appId);
      log("autoscale", `Scaling to zero app ${appId}: idle for ${Math.round(idleDuration)}s (threshold: ${idleTimeout}s)`);
      const result = await scaleApp(appId, 0);
      if (result.ok) {
        db.insertScalingEvent({
          app_id: appId,
          event_type: "autoscale_sleep",
          from_count: 1,
          to_count: 0,
          reason: `Idle for ${Math.round(idleDuration)}s — CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}%`,
        });
      }
    } else {
      // Normal scale-down (N → N-1, where N-1 >= 1)
      log("autoscale", `Scaling down app ${appId}: CPU=${avgCpu.toFixed(1)}% < ${app.autoscale_cpu_threshold * 0.5}% and MEM=${avgMem.toFixed(1)}% < ${app.autoscale_mem_threshold * 0.5}%`);
      const result = await scaleApp(appId, replicas.length - 1);
      if (result.ok) {
        db.insertScalingEvent({
          app_id: appId,
          event_type: "autoscale_down",
          from_count: replicas.length,
          to_count: replicas.length - 1,
          reason: `CPU ${avgCpu.toFixed(1)}% / MEM ${avgMem.toFixed(1)}% below thresholds`,
        });
      }
    }
  }
}

/**
 * Wake a sleeping app (scale-to-zero → 1 replica).
 * Restarts the container on the server where it was last running.
 */
export async function wakeApp(appId: number): Promise<{ ok: boolean; error?: string }> {
  log("wake", `Waking app ${appId}`);

  try {
    const app = db.getApp(appId);
    if (!app) return { ok: false, error: "App not found" };
    if (app.status !== "sleeping") return { ok: true }; // already awake or waking

    const serverId = app.sleeping_server_id;
    const hostPort = app.sleeping_host_port;
    if (!serverId || !hostPort) return { ok: false, error: "Missing sleeping state" };

    const server = db.getServer(serverId);
    if (!server) return { ok: false, error: "Server not found" };

    db.updateAppStatus(appId, "waking");
    const hostKey = server.ssh_host_key || undefined;
    const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
    const containerName = app.name;

    // Start container
    if (app.deploy_mode === "compose") {
      await hetzner.sshExec(server.ipv4, asUser(
        `cd /home/deploy/apps/${app.name} && docker compose -p ${app.name} up -d`
      ), hostKey);
    } else {
      const envVars = JSON.parse(app.env_vars || "{}");
      let envFileFlag = "";
      if (Object.keys(envVars).length > 0) {
        envFileFlag = `--env-file /home/deploy/apps/${app.name}/.env.deploy`;
      }
      const volumeFlag = app.volume_mount ? `-v ${app.volume_mount}` : "";
      const cmd = `docker run -d --name ${containerName} --restart unless-stopped ` +
        `-p 127.0.0.1:${hostPort}:${app.container_port} ${envFileFlag} ${volumeFlag} ${app.name}:latest`;
      await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
    }

    // Health check
    const health = app.deploy_mode === "compose"
      ? await hetzner.composeHealthCheck(server.ipv4, app.name, hostPort, 5, hostKey)
      : await hetzner.healthCheck(server.ipv4, containerName, hostPort, 5, hostKey);

    // Re-deploy auth proxy if needed
    if (app.auth_password) {
      await hetzner.deployAuthProxy(server.ipv4, containerName, app.auth_password, hostPort, hostKey);
    }

    // Restore Caddy reverse proxy route
    const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
    const caddyPort = app.auth_password ? hetzner.authProxyPort(hostPort) : hostPort;
    await hetzner.deployCaddySite(server.ipv4, app.domain, caddyPort, useInternalTls, hostKey);

    // Insert replica record
    db.insertReplica({
      app_id: appId,
      server_id: serverId,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "running" : "unhealthy",
    });

    // Clear sleeping state
    db.clearAppSleepingState(appId);
    db.updateAppScaling(appId, { desired_replicas: 1, last_scale_at: new Date().toISOString() });
    db.updateAppStatus(appId, "running");
    db.insertScalingEvent({ app_id: appId, event_type: "wake", from_count: 0, to_count: 1, reason: "wake request" });

    log("wake", `App ${appId} woken successfully`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("wake", `Failed to wake app ${appId}: ${msg}`);
    db.updateAppStatus(appId, "error");
    return { ok: false, error: msg };
  }
}

/**
 * Rolling redeploy: update each replica one at a time with no downtime.
 */
export async function rollingRedeploy(
  appId: number,
  onProgress?: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const emit = onProgress || (() => {});

  try {
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");

    const replicas = db.getReplicas(appId);
    if (replicas.length <= 1) {
      return { ok: true }; // Single replica handled by normal redeploy
    }

    // Use the first replica's server as the image source for transferImage.
    const primaryServer = db.getServer(replicas[0].server_id);
    if (!primaryServer) throw new Error("First replica's server not found");

    const lbId = app.hetzner_lb_id;
    if (!lbId) throw new Error("No load balancer found for rolling deploy");

    const imageName = `${app.name}:latest`;
    const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;

    for (let i = 0; i < replicas.length; i++) {
      const replica = replicas[i];
      const server = db.getServer(replica.server_id);
      if (!server) continue;

      const hostKey = server.ssh_host_key || undefined;
      emit("scale", `Rolling update ${i + 1}/${replicas.length}: ${replica.container_name}...`);

      // Transfer new image
      if (server.id !== primaryServer.id) {
        await hetzner.transferImage(
          primaryServer.ipv4,
          server.ipv4,
          imageName,
          primaryServer.ssh_host_key || undefined,
          hostKey
        );
      }

      // Remove from LB
      try {
        await hetzner.removeLBTarget(lbId, server.hetzner_id);
      } catch (e) {
        log("lb", `Failed to remove LB target for ${replica.container_name}:`, e);
      }

      // Drain
      emit("scale", `Draining ${replica.container_name}...`);
      await Bun.sleep(10_000);

      // Recreate container
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      if (app.deploy_mode === "compose") {
        await hetzner.cloneAndComposeBuild(
          server.ipv4,
          {
            name: app.name,
            gitRepo: app.git_repo,
            port: app.container_port,
            hostPort: replica.host_port,
            envVars: JSON.parse(app.env_vars || "{}"),
            volumeMount: app.volume_mount || undefined,
            composeFile: app.compose_file,
            webService: app.compose_web_service,
            gitToken: githubPat,
          },
          (line) => emit("scale", line)
        );
      } else {
        await hetzner.sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);
        const envVars = JSON.parse(app.env_vars || "{}");
        const envEntries = Object.entries(envVars);
        let envFileFlag = "";
        if (envEntries.length > 0) {
          const envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
          envFileFlag = `--env-file ${envFilePath}`;
        }
        const cmd = `docker run -d --name ${replica.container_name} --restart unless-stopped -p 0.0.0.0:${replica.host_port}:${app.container_port} ${envFileFlag} ${imageName}`;
        await hetzner.sshExec(server.ipv4, asUser(cmd), hostKey);
      }

      // Health check
      const health = app.deploy_mode === "compose"
        ? await hetzner.composeHealthCheck(server.ipv4, app.name, replica.host_port, 5, hostKey)
        : await hetzner.healthCheck(server.ipv4, replica.container_name, replica.host_port, 5, hostKey);

      db.updateReplicaStatus(replica.id, health.healthy ? "running" : "unhealthy");

      // Add back to LB
      await hetzner.addLBTarget(lbId, server.hetzner_id);

      emit("scale", `Replica ${replica.container_name} updated`);
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("rolling", `Rolling redeploy failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
