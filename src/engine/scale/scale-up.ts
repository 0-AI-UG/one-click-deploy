import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, cloneAndComposeBuild, cloneAndBuild, cloneAndRailpackBuild,
  transferImage, healthCheck, composeHealthCheck,
  deployAuthProxy, removeAuthProxy,
  describeFailure, buildDockerRunArgs,
} from "../../shared/remote/index.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { type ProgressFn, log, type App, type Replica, replicaBindHost } from "./types.ts";
import { pickTargetServer } from "./server-picker.ts";
import { syncAppCaddy } from "./caddy-manager.ts";

export async function scaleUp(
  app: App,
  currentReplicas: Replica[],
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

  for (let i = currentCount; i < targetCount; i++) {
    const replicaNum = i + 1;
    emit("scale", `Provisioning replica ${replicaNum}/${targetCount}...`);

    // Pick target server: user-specified, least-loaded existing, or newly provisioned
    let targetServer = await pickTargetServer(app, settings, emit, targetServerId);
    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Every replica listens on the same host port — the Caddy upstream
    // list derives upstream ports from the replica row, and using a
    // stable hostPort keeps the cross-server container layout easy to
    // reason about.
    const hostPort = primaryHostPort;

    // Bind the replica on the target server's private IPv4. Traffic from
    // the panel Caddy uses the private network, so the public NIC is
    // never touched for inter-server app traffic. Fails fast if the
    // target isn't yet attached to the shared network.
    const replicaBindAddr = replicaBindHost(targetServer);

    // Transfer image to target server
    emit("scale", `Transferring image to ${targetServer.name}...`);
    const imageName = `${app.name}:latest`;

    let scaleExtraVols: string[] = [];
    try { const ev = JSON.parse(app.extra_volumes); if (Array.isArray(ev)) scaleExtraVols = ev; } catch {}
    // Set when transferImage fails and we successfully rebuild from git on the
    // target — the build helper runs the replica container itself, so the
    // manual env-file/docker-run block below is skipped.
    let rebuildFallback = false;
    if (app.deploy_mode === "compose") {
      // For compose, clone repo and build on target
      await cloneAndComposeBuild(
        targetServer.ipv4,
        {
          name: app.name,
          gitRepo: app.git_repo,
          port: app.container_port,
          hostPort,
          envVars: await resolveAppEnvVars(app),
          volumeMount: app.volume_mount || undefined,
          extraVolumes: scaleExtraVols,
          composeFile: app.compose_file,
          webService: app.compose_web_service,
          gitToken: githubPat,
          gitBranch: app.git_branch || undefined,
          bindAddr: replicaBindAddr,
        },
        (line) => emit("scale", line)
      );
    } else {
      try {
        await transferImage(
          primaryServer.ipv4,
          targetServer.ipv4,
          imageName,
          primaryServer.ssh_host_key || undefined,
          targetHostKey
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit("scale", `Image transfer from primary failed: ${msg}`);
        if (!app.git_repo) {
          throw new Error(`Image '${imageName}' missing on source server and app has no git_repo configured for rebuild fallback.`);
        }
        // Rebuild on the target from git. Match the dispatch in
        // ops/redeploy.ts so the rebuilt image is identical to what an
        // initial deploy would produce.
        emit("scale", `Falling back to rebuild from git on ${targetServer.name}...`);
        rebuildFallback = true;
      }
    }

    if (rebuildFallback) {
      const containerNameForBuild = `${app.name}-r${replicaNum}`;
      const buildOpts = {
        name: app.name,
        gitRepo: app.git_repo,
        port: app.container_port,
        hostPort,
        envVars: await resolveAppEnvVars(app),
        volumeMount: app.volume_mount || undefined,
        extraVolumes: scaleExtraVols,
        gitToken: githubPat,
        gitBranch: app.git_branch || undefined,
        bindAddr: replicaBindAddr,
        containerName: containerNameForBuild,
        memoryMb: app.memory_mb || undefined,
      };
      const logLine = (line: string) => emit("scale", line);
      if (app.deploy_mode === "railpack") {
        await cloneAndRailpackBuild(targetServer.ipv4, buildOpts, logLine);
      } else {
        await cloneAndBuild(targetServer.ipv4, {
          ...buildOpts,
          dockerfilePath: app.dockerfile_path || undefined,
          dockerContext: app.docker_context || undefined,
        }, logLine);
      }
    }

    const containerName = `${app.name}-r${replicaNum}`;

    // Defensive cleanup: a previous failed scale-up or migration may have left
    // a same-named container on the target, which would squat on the
    // private-IP host port and make `docker run` fail with
    // "port is already allocated". Removing it here makes retries idempotent.
    // (Auth proxy is a systemd unit handled by deployAuthProxy itself.)
    // Skipped on rebuildFallback: cloneAndBuild/cloneAndRailpackBuild already
    // started the replica container above; removing it here would undo that.
    if (!rebuildFallback) {
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
      await sshExec(targetServer.ipv4, asUser(`docker rm -f ${containerName} 2>/dev/null || true`), targetHostKey);
    }

    if (app.deploy_mode !== "compose" && !rebuildFallback) {
      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;
      const envVars = await resolveAppEnvVars(app);
      const envEntries = Object.entries(envVars);
      let envFilePath: string | undefined;
      if (envEntries.length > 0) {
        envFilePath = `/home/deploy/apps/${app.name}/.env.deploy`;
        const envFileContent = envEntries.map(([k, v]) => `${k}=${v}`).join("\n");
        const escapedContent = envFileContent.replace(/'/g, "'\\''");
        await sshExec(targetServer.ipv4, `mkdir -p /home/deploy/apps/${app.name} && chown deploy:deploy /home/deploy/apps /home/deploy/apps/${app.name}`, targetHostKey);
        await sshExec(targetServer.ipv4, `echo '${escapedContent}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`, targetHostKey);
      }
      const cmd = buildDockerRunArgs({
        name: containerName,
        image: imageName,
        appName: app.name,
        network: null, // scale-up replicas historically don't join ocd-net
        publish: { bindAddr: replicaBindAddr, hostPort, containerPort: app.container_port },
        envFilePath,
        volumeMount: app.volume_mount || undefined,
        extraVolumes: scaleExtraVols,
        memoryMb: app.memory_mb || undefined,
      });
      const result = await sshExec(targetServer.ipv4, asUser(cmd), targetHostKey);
      if (result.exitCode !== 0) {
        throw new Error(describeFailure("Failed to start replica on target server", result));
      }
    }

    // Deploy auth proxy on new server if needed
    if (app.auth_password) {
      await deployAuthProxy(
        targetServer.ipv4,
        containerName,
        app.auth_password,
        hostPort,
        replicaBindAddr,
        targetHostKey
      );
    }

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const health = app.deploy_mode === "compose"
      ? await composeHealthCheck(targetServer.ipv4, app.name, replicaBindAddr, hostPort, 5, targetHostKey)
      : await healthCheck(targetServer.ipv4, containerName, replicaBindAddr, hostPort, 5, targetHostKey);

    // Insert replica record BEFORE syncing Caddy so the upstream list
    // built from the DB actually includes the new replica.
    db.insertReplica({
      app_id: app.id,
      server_id: targetServer.id,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "running" : "unhealthy",
    });

    // Push the updated upstream list to the panel Caddy. One reload per
    // replica is fine — Caddy's admin API applies config atomically.
    await syncAppCaddy(app.id);

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

  // Rewrite the Caddy vhost so it reflects the remaining replicas.
  try {
    await syncAppCaddy(app.id);
  } catch (err) {
    log("rollback", `Failed to sync Caddy after rollback: ${err}`);
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
