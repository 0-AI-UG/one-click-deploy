import * as db from "../db.ts";
import { getComputeProvider, getDnsProvider } from "../providers/index.ts";
import {
  sshExec, removeCaddySite, deployCaddySite, cloneAndComposeBuild,
  transferImage, healthCheck, composeHealthCheck,
  authProxyPort, deployAuthProxy, removeAuthProxy,
} from "../remote/index.ts";
import { resolveGitHubToken } from "../github-token.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";
import { pickTargetServer } from "./server-picker.ts";
import { rebindContainer } from "./rebind.ts";

export async function scaleUp(
  app: App,
  currentReplicas: Replica[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn,
  targetServerId?: number
) {
  const compute = getComputeProvider();
  const dns = getDnsProvider();
  const settings = db.getSettings();
  const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
  // The "primary" is just whichever server hosts the first (oldest) replica.
  const firstReplica = currentReplicas[0];
  const primaryServer = db.getServer(firstReplica.server_id);
  if (!primaryServer) throw new Error("First replica's server not found");
  const primaryHostPort = firstReplica.host_port;

  // Validate that stored LB still exists (may have been deleted externally)
  if (app.lb_provider_id) {
    const lb = await compute.loadBalancers!.get(app.lb_provider_id).catch(() => null);
    if (!lb) {
      log("scale", `Load balancer ${app.lb_provider_id} not found, will re-create`);
      db.updateAppScaling(app.id, { lb_provider_id: "" });
      app = { ...app, lb_provider_id: "" };
    }
  }

  // If going from 1 to N, set up LB
  if (currentCount === 1 && !app.lb_provider_id) {
    emit("scale", "Creating load balancer...");

    // Create LB
    const lb = await compute.loadBalancers!.create(app.name, primaryServer.location);
    db.updateAppScaling(app.id, { lb_provider_id: lb.providerId });
    // Mirror the DB write into the local app object so the "Add new replicas"
    // block below reads the fresh provider id instead of the stale empty string
    // (which would call GET /load_balancers/ and crash on lb.public_net).
    app = { ...app, lb_provider_id: lb.providerId };

    // Create managed TLS certificate (only for real domains, not nip.io)
    let certId: number | undefined;
    if (app.domain && !app.domain.endsWith(".nip.io")) {
      emit("scale", "Creating TLS certificate...");
      try {
        const cert = await compute.loadBalancers!.createCertificate(app.name, app.domain);
        certId = Number(cert.providerId);
        // Wait a moment for cert to register
        await Bun.sleep(2000);
      } catch (err) {
        log("scale", `Certificate creation failed (will use HTTP): ${err}`);
      }
    }

    // Add LB service — uses HTTPS if cert available, HTTP otherwise
    const destPort = app.auth_password
      ? authProxyPort(primaryHostPort)
      : primaryHostPort;
    await compute.loadBalancers!.addService(
      lb.providerId,
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
      const newRecord = await dns.createRecord({
        zoneId: dnsSettings.dns_zone_id,
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
          await dns.deleteRecord({
            zoneId: record.zone_id,
            name: record.name,
            type: record.type,
            value: record.value,
          });
          db.deleteDnsRecord(record.record_id);
        } catch (err) {
          log("scale", `Failed to delete DNS record during rollback: ${err}`);
        }
      }
    }

    // Re-bind existing container to 0.0.0.0
    const bindAddr = "0.0.0.0";
    emit("scale", `Re-binding container to ${bindAddr}...`);
    const primaryHostKey = primaryServer.ssh_host_key || undefined;

    await rebindContainer(primaryServer.ipv4, app, bindAddr, primaryHostPort, primaryHostKey);

    // Add firewall rule for LB access
    const firewallId = await compute.ensureFirewall();
    await compute.firewallRules?.addLBRule(firewallId, destPort, lb.ipv4);

    // Add primary server as LB target
    await compute.loadBalancers!.addTarget(lb.providerId, primaryServer.provider_id);

    // Remove Caddy reverse proxy (LB handles TLS now)
    await removeCaddySite(primaryServer.ipv4, app.domain, primaryHostKey);

    emit("scale", "Load balancer ready");
  }

  // Add new replicas
  const lbId = app.lb_provider_id;
  const lb = await compute.loadBalancers!.get(lbId);
  const lbIpv4 = lb.ipv4;

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
      await cloneAndComposeBuild(
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
      await transferImage(
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
        await sshExec(targetServer.ipv4, `mkdir -p /home/deploy/apps/${app.name}`, targetHostKey);
        await sshExec(targetServer.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, targetHostKey);
        envFileFlag = `--env-file ${envFilePath}`;
      }
      const replicaBindAddr = "0.0.0.0";
      const cmd = `docker run -d --name ${containerName} --restart unless-stopped -p ${replicaBindAddr}:${hostPort}:${app.container_port} ${envFileFlag} ${imageName}`;
      const result = await sshExec(targetServer.ipv4, asUser(cmd), targetHostKey);
      if (result.exitCode !== 0) {
        throw new Error("Failed to start replica on target server — check that Docker is running and the image was transferred");
      }
    }

    // Deploy auth proxy on new server if needed
    if (app.auth_password) {
      await deployAuthProxy(
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
      ? await composeHealthCheck(targetServer.ipv4, app.name, hostPort, 5, targetHostKey)
      : await healthCheck(targetServer.ipv4, containerName, hostPort, 5, targetHostKey);

    // Add LB target
    await compute.loadBalancers!.addTarget(lbId, targetServer.provider_id);

    // Add firewall rule
    const firewallId = await compute.ensureFirewall();
    const destPort = app.auth_password ? authProxyPort(hostPort) : hostPort;
    await compute.firewallRules?.addLBRule(firewallId, destPort, lbIpv4);

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

export async function rollbackScaleUp(
  app: App,
  originalReplicas: Replica[],
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
        await sshExec(server.ipv4, `su - deploy -c "docker rm -f ${replica.container_name} 2>/dev/null || true"`, hostKey);
      } catch (err) {
        log("scale", `Rollback: failed to remove container ${replica.container_name}: ${err}`);
      }
      if (app.auth_password) {
        try { await removeAuthProxy(server.ipv4, replica.container_name, hostKey); } catch { /* cleanup, container may already be gone */ }
      }
    }
    db.deleteReplica(replica.id);
  }

  // If LB was just created (wasn't there before), tear it down
  const compute = getComputeProvider();
  const lbId = freshApp.lb_provider_id;
  if (lbId && !app.lb_provider_id && primaryServer) {
    emit("scale", "Removing load balancer...");
    try { await compute.loadBalancers!.delete(lbId); } catch (e) {
      log("rollback", `Failed to delete LB ${lbId}: ${e}`);
    }
    db.updateAppScaling(app.id, { lb_provider_id: "" });

    // Restore container to 127.0.0.1 binding
    const primaryHostKey = primaryServer.ssh_host_key || undefined;
    try {
      await rebindContainer(primaryServer.ipv4, app, "127.0.0.1", primaryHostPort, primaryHostKey);
    } catch (e) {
      log("rollback", `Failed to restore container binding: ${e}`);
    }

    // Restore Caddy
    try {
      const useInternalTls = !app.domain || app.domain.endsWith(".nip.io");
      const caddyPort = app.auth_password ? authProxyPort(primaryHostPort) : primaryHostPort;
      await deployCaddySite(primaryServer.ipv4, app.domain, caddyPort, useInternalTls, primaryHostKey);
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
