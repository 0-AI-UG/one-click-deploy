import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, cloneAndBuild, pullImmutableImageAndRun,
  transferImage, probeAppHealth, startAppReplica,
} from "../../shared/remote/index.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import { type ProgressFn, log, type App, type Replica, replicaBindHost, appReplicaRunOpts } from "./types.ts";
import { pickTargetServer } from "./server-picker.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";

export async function scaleUp(
  app: App,
  currentReplicas: Replica[],
  currentCount: number,
  targetCount: number,
  emit: ProgressFn,
  targetServerId?: number,
  preReservedPort?: { id: number; server_id: number; bind_address: string; host_port: number },
  allowServerProvisioning = false,
) {
  const settings = db.getSettings();
  const githubPat = (await resolveGitHubToken(app.deployed_by || undefined)) || undefined;
  // The "primary" is just whichever server hosts the first (oldest) replica.
  const firstReplica = currentReplicas[0];
  const primaryServer = firstReplica ? db.getServer(firstReplica.server_id) : null;
  if (firstReplica && !primaryServer) throw new Error("First replica's server not found");
  const primaryHostPort = firstReplica?.host_port;

  for (let i = currentCount; i < targetCount; i++) {
    let replicaNum = i + 1;
    const existingNames = new Set(db.getReplicas(app.id).map((replica) => replica.container_name));
    while (existingNames.has(`${app.name}-r${replicaNum}`)) replicaNum++;
    emit("scale", `Provisioning replica ${replicaNum}/${targetCount}...`);

    // Pick target server: user-specified, least-loaded existing, or newly
    // provisioned. No in-pass placement map is threaded here: each replica is
    // persisted via insertReplica (below) before the next iteration's pick, so
    // the picker's DB read already reflects prior placements decided this pass
    // (anti-affinity / min_locations spread stay correct without double-counting).
    let targetServer = await pickTargetServer(
      app,
      settings,
      emit,
      targetServerId,
      undefined,
      allowServerProvisioning,
    );
    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Every replica listens on the same host port — the ingress upstream
    // list derives upstream ports from the replica row, and using a
    // stable hostPort keeps the cross-server container layout easy to
    // reason about.
    const hostPort = primaryHostPort ?? db.nextReplicaHostPort(targetServer.id);

    // Bind the replica on the target server's private IPv4. Traffic from
    // the ingress layer uses the private network, so the public NIC is
    // never touched for inter-server app traffic. Fails fast if the
    // target isn't yet attached to the shared network.
    const replicaBindAddr = replicaBindHost(targetServer);
    const containerName = `${app.name}-r${replicaNum}`;

    // Claim and verify the complete bind tuple before image transfer. The DB
    // reservation serializes OCD operations; the Docker probe catches an
    // orphan or out-of-band workload unknown to the DB.
    const ownsReservation = !preReservedPort;
    const reservation = preReservedPort ?? db.reserveHostPort({
        serverId: targetServer.id,
        bindAddress: replicaBindAddr,
        hostPort,
        protocol: "tcp",
        ownerType: "replica",
        ownerId: `${app.id}:${containerName}`,
      });
    if (
      reservation.server_id !== targetServer.id ||
      reservation.bind_address !== replicaBindAddr ||
      reservation.host_port !== hostPort
    ) throw new Error("Pre-reserved port tuple does not match selected target");
    try {
      const bindProbe = await sshExec(
        targetServer.ipv4,
        `su - deploy -c ${JSON.stringify(`docker ps --filter publish=${hostPort} --format '{{.Names}}'`)}`,
        targetHostKey,
      );
      const conflicts = bindProbe.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
        .filter((name) => name !== containerName);
      if (bindProbe.exitCode !== 0 || conflicts.length > 0) {
        throw new Error(
          `Port preflight failed for ${replicaBindAddr}:${hostPort}/tcp` +
            (conflicts.length ? `; held by ${conflicts.join(", ")}` : `; Docker probe failed`),
        );
      }

    // Transfer the immutable deployed image, never a mutable convenience tag.
    emit("scale", `Ensuring image revision on ${targetServer.name}...`);
    const imageName = latestDesiredImage(app);

    const scaleExtraVols = db.parseExtraVolumes(app.extra_volumes);
    // Set when transferImage fails and we successfully rebuild from git on the
    // target — the build helper runs the replica container itself, so the
    // manual env-file/docker-run block below is skipped.
    let rebuildFallback = false;
    try {
      if (!primaryServer) throw new Error("no healthy source replica is available");
      await transferImage(
        primaryServer.ipv4,
        targetServer.ipv4,
        imageName,
        primaryServer.ssh_host_key || undefined,
        targetHostKey,
        {
          registryRef: app.build_cache_ref || undefined,
          registryToken: githubPat,
          allowArchiveFallback: db.getSettings().allow_archive_image_transfer === "1",
          onProgress: (line) => emit("transfer", line),
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit("scale", `Image transfer from primary failed: ${msg}`);
      if (!app.git_repo && app.source_mode !== "image") {
        throw new Error(`Image '${imageName}' missing on source server and app has no git_repo configured for rebuild fallback.`);
      }
      // Rebuild on the target from git. Match the dispatch in
      // ops/redeploy.ts so the rebuilt image is identical to what an
      // initial deploy would produce.
      emit("scale", app.source_mode === "image"
        ? `Falling back to immutable registry pull on ${targetServer.name}...`
        : `Falling back to rebuild from git on ${targetServer.name}...`);
      rebuildFallback = true;
    }

    if (rebuildFallback) {
      const containerNameForBuild = containerName;
      const rebuildEnv = await resolveAppEnvVars(app);
      const buildOpts = {
        name: app.name,
        gitRepo: app.git_repo,
        port: app.container_port,
        hostPort,
        envVars: rebuildEnv,
        volumeMount: app.volume_mount || undefined,
        extraVolumes: scaleExtraVols,
        gitToken: githubPat,
        gitBranch: app.git_branch || undefined,
        bindAddr: replicaBindAddr,
        containerName: containerNameForBuild,
        memoryMb: app.memory_mb || undefined,
        cpus: app.cpu_limit || undefined,
        hostKey: targetHostKey,
        configRevision: app.config_revision,
        envHash: hashEnvironment(rebuildEnv),
      };
      const logLine = (line: string) => emit("scale", line);
      if (app.source_mode === "image") {
        await pullImmutableImageAndRun(targetServer.ipv4, {
          ...buildOpts,
          imageRef: app.image_ref,
        }, logLine);
      } else {
        await cloneAndBuild(targetServer.ipv4, {
          ...buildOpts,
          dockerfilePath: app.dockerfile_path || undefined,
          dockerContext: app.docker_context || undefined,
          buildCacheRef: app.build_cache_ref || undefined,
        }, logLine);
      }
    }

    // On the transfer (non-rebuild) path we start the replica ourselves.
    // startAppReplica force-removes any same-named squatter first: a previous
    // failed scale-up or migration may have left one holding the private-IP
    // host port, which would make the run fail with "port already allocated".
    // Skipped on rebuildFallback: cloneAndBuild already started the container.
    const resolvedEnv = await resolveAppEnvVars(app);
    if (!rebuildFallback) {
      await startAppReplica(targetServer.ipv4, {
        ...appReplicaRunOpts(app, targetServer, { containerName, hostPort, envVars: resolvedEnv }),
      }, targetHostKey);
    }

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const health = await probeAppHealth(app, targetServer.ipv4, containerName, replicaBindAddr, hostPort, 5, targetHostKey);

    // Insert replica record BEFORE syncing ingress so the upstream pool
    // built from the DB actually includes the new replica.
    const inserted = db.insertReplica({
      app_id: app.id,
      server_id: targetServer.id,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "attesting" : "unhealthy",
    });

    if (!health.healthy) {
      throw new Error(`Replica ${containerName} did not become healthy and will not be attached to ingress`);
    }
    const desiredDeployment = db.getDeployments(app.id).find((d) => d.status === "deployed");
    const expected = {
      imageDigest: desiredDeployment?.image_digest || app.image_ref || imageName,
      envHash: hashEnvironment(resolvedEnv),
      configRevision: app.config_revision,
    };
    const attestation = await attestReplica(app, inserted, targetServer, expected);
    if (!attestation.ok) {
      throw new Error(`Replica ${inserted.id} revision attestation failed: ${attestation.error}`);
    }
    db.updateReplicaStatus(inserted.id, "running");

    // Push the updated upstream pool to the fleet ingress. One re-render per
    // replica is fine — dynamic config writes are atomic (tmp+mv).
    await syncAppIngress(app.id);

    emit("scale", `Replica ${replicaNum} deployed on ${targetServer.name}`);
    } finally {
      if (ownsReservation) db.releaseHostPortReservation(reservation.id);
    }
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
