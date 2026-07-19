import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, cloneAndBuild,
  transferImage, probeAppHealth, startAppReplica,
} from "../../shared/remote/index.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { type ProgressFn, log, type App, type Replica, replicaBindHost, appReplicaRunOpts } from "./types.ts";
import { pickTargetServer } from "./server-picker.ts";
import { syncAppIngress } from "./traefik-manager.ts";

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

    // Pick target server: user-specified, least-loaded existing, or newly
    // provisioned. No in-pass placement map is threaded here: each replica is
    // persisted via insertReplica (below) before the next iteration's pick, so
    // the picker's DB read already reflects prior placements decided this pass
    // (anti-affinity / min_locations spread stay correct without double-counting).
    let targetServer = await pickTargetServer(app, settings, emit, targetServerId);
    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Every replica listens on the same host port — the ingress upstream
    // list derives upstream ports from the replica row, and using a
    // stable hostPort keeps the cross-server container layout easy to
    // reason about.
    const hostPort = primaryHostPort;

    // Bind the replica on the target server's private IPv4. Traffic from
    // the ingress layer uses the private network, so the public NIC is
    // never touched for inter-server app traffic. Fails fast if the
    // target isn't yet attached to the shared network.
    const replicaBindAddr = replicaBindHost(targetServer);

    // Transfer image to target server
    emit("scale", `Transferring image to ${targetServer.name}...`);
    const imageName = `${app.name}:latest`;

    const scaleExtraVols = db.parseExtraVolumes(app.extra_volumes);
    // Set when transferImage fails and we successfully rebuild from git on the
    // target — the build helper runs the replica container itself, so the
    // manual env-file/docker-run block below is skipped.
    let rebuildFallback = false;
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
        cpus: app.cpu_limit || undefined,
        hostKey: targetHostKey,
      };
      const logLine = (line: string) => emit("scale", line);
      await cloneAndBuild(targetServer.ipv4, {
        ...buildOpts,
        dockerfilePath: app.dockerfile_path || undefined,
        dockerContext: app.docker_context || undefined,
      }, logLine);
    }

    const containerName = `${app.name}-r${replicaNum}`;

    // On the transfer (non-rebuild) path we start the replica ourselves.
    // startAppReplica force-removes any same-named squatter first: a previous
    // failed scale-up or migration may have left one holding the private-IP
    // host port, which would make the run fail with "port already allocated".
    // Skipped on rebuildFallback: cloneAndBuild already started the container.
    if (!rebuildFallback) {
      await startAppReplica(targetServer.ipv4, {
        ...appReplicaRunOpts(app, targetServer, { containerName, hostPort, envVars: await resolveAppEnvVars(app) }),
      }, targetHostKey);
    }

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const health = await probeAppHealth(app, targetServer.ipv4, containerName, replicaBindAddr, hostPort, 5, targetHostKey);

    // Insert replica record BEFORE syncing ingress so the upstream pool
    // built from the DB actually includes the new replica.
    db.insertReplica({
      app_id: app.id,
      server_id: targetServer.id,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "running" : "unhealthy",
    });

    // Push the updated upstream pool to the fleet ingress. One re-render per
    // replica is fine — dynamic config writes are atomic (tmp+mv).
    await syncAppIngress(app.id);

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
    }
    db.deleteReplica(replica.id);
  }

  // Re-render ingress so it reflects the remaining replicas.
  try {
    await syncAppIngress(app.id);
  } catch (err) {
    log("rollback", `Failed to sync ingress after rollback: ${err}`);
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
