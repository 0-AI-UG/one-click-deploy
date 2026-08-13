import { statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { sshExec, sshExecStreaming, getSshKeyPath, describeFailure } from "./ssh.ts";
import { log } from "./container-common.ts";
import { dockerLoginGhcr, dockerLoginRegistry } from "./registry.ts";
import { preflightTransferDiskSpace } from "./disk-space.ts";

export type ImageTransferProgress = (line: string) => void;

function artifactRef(cacheRef: string, imageId: string): string {
  const lastSlash = cacheRef.lastIndexOf("/");
  const lastColon = cacheRef.lastIndexOf(":");
  const repo = lastColon > lastSlash ? cacheRef.slice(0, lastColon) : cacheRef;
  return `${repo}:ocd-${imageId.replace(/^sha256:/, "").slice(0, 32)}`;
}

function protectedImageRefs(imageName: string): string[] {
  if (imageName.startsWith("sha256:") || imageName.includes("@sha256:")) return [imageName];
  const lastSlash = imageName.lastIndexOf("/");
  const lastColon = imageName.lastIndexOf(":");
  const repository = lastColon > lastSlash ? imageName.slice(0, lastColon) : imageName;
  return [imageName, `${repository}:rollback`];
}

function transferProgress(label: string, bytes: number, total: number, started: number): string {
  const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
  const rate = bytes / elapsed;
  const percent = total > 0 ? Math.min(100, bytes / total * 100) : 0;
  const remaining = rate > 0 ? Math.max(0, total - bytes) / rate : Number.POSITIVE_INFINITY;
  const eta = Number.isFinite(remaining) ? `${Math.ceil(remaining)}s remaining` : "estimating remaining time";
  return `[archive ${label}] ${(bytes / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MiB ` +
    `(${percent.toFixed(1)}%, ${(rate / 1024 / 1024).toFixed(1)} MiB/s, ${eta})`;
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
};

/** Sum the final compressed byte totals Docker reports for layers actually
 * downloaded. Repeated carriage-return progress frames are de-duplicated by
 * layer id. Returns undefined when the daemon did not expose byte progress. */
export function parseDockerPullTransferBytes(output: string): number | undefined {
  const layers = new Map<string, number>();
  const pattern = /([a-f0-9]{8,64}):\s+Downloading[^\r\n]*?\/\s*([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB)\b/gi;
  for (const match of output.matchAll(pattern)) {
    const bytes = Number(match[2]) * (BYTE_UNITS[match[3].toLowerCase()] ?? 1);
    if (Number.isFinite(bytes) && bytes > 0) {
      layers.set(match[1], Math.max(layers.get(match[1]) ?? 0, Math.round(bytes)));
    }
  }
  if (layers.size === 0) return undefined;
  return [...layers.values()].reduce((sum, value) => sum + value, 0);
}

async function scpWithProgress(
  args: string[],
  label: "download" | "upload",
  totalBytes: number,
  bytesTransferred: () => Promise<number>,
  emit: ImageTransferProgress,
): Promise<void> {
  const maxAttempts = 2;
  for (let transferAttempt = 1; transferAttempt <= maxAttempts; transferAttempt++) {
    emit(`[archive ${label}] attempt ${transferAttempt}/${maxAttempts} started`);
    const started = Date.now();
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stderrPromise = new Response(proc.stderr).text();
    let exitCode: number | null = null;
    const exitPromise = proc.exited.then((code) => { exitCode = code; });
    while (exitCode === null) {
      await Promise.race([exitPromise, Bun.sleep(15_000)]);
      if (exitCode === null) {
        const bytes = await bytesTransferred().catch(() => 0);
        emit(transferProgress(label, bytes, totalBytes, started));
      }
    }
    const stderr = await stderrPromise;
    if (exitCode === 0) {
      emit(transferProgress(label, totalBytes, totalBytes, started));
      return;
    }
    const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) || `exit ${exitCode}`;
    if (transferAttempt < maxAttempts) {
      emit(`[archive ${label}] attempt ${transferAttempt} ended non-zero (${detail}); retrying`);
      continue;
    }
    throw new Error(`${label} attempt ${transferAttempt} ended non-zero: ${detail}`);
  }
}

export async function transferImage(
  sourceIp: string,
  targetIp: string,
  imageName: string,
  sourceHostKey?: string,
  targetHostKey?: string,
  opts: {
    registryRef?: string;
    registryToken?: string;
    registryUsername?: string;
    registryPassword?: string;
    onProgress?: ImageTransferProgress;
    attempt?: number;
    /** Emergency-only escape hatch. Normal multi-host distribution requires
     * a registry so retries use immutable, content-addressed layers. */
    allowArchiveFallback?: boolean;
    /** Persist exact storage facts when the owning deployment is known. */
    onStorage?: (storage: {
      imageBytes: number;
      archiveBytes?: number;
      transferBytes?: number;
    }) => void;
  } = {},
): Promise<void> {
  const emit = opts.onProgress ?? (() => {});
  const attempt = opts.attempt ?? 1;
  log("transfer", `attempt ${attempt}: ensuring image ${imageName} from ${sourceIp} on ${targetIp}`);
  emit(`Image transfer attempt ${attempt}: ${imageName}`);

  const sourceInspect = await sshExec(
    sourceIp,
    `su - deploy -c ${JSON.stringify(`docker image inspect --format '{{.Id}} {{.Size}}' ${imageName}`)}`,
    sourceHostKey,
  );
  const [expectedImageId = "", imageSizeRaw = ""] = sourceInspect.stdout.trim().split(/\s+/);
  const imageBytes = Number(imageSizeRaw) || 0;
  if (sourceInspect.exitCode !== 0 || !expectedImageId || imageBytes <= 0) {
    throw new Error(describeFailure("Image distribution preflight failed", sourceInspect));
  }
  opts.onStorage?.({ imageBytes });
  const alreadyPresent = await sshExec(
    targetIp,
    `su - deploy -c ${JSON.stringify(`docker image inspect --format '{{.Id}}' ${expectedImageId}`)}`,
    targetHostKey,
  );
  if (alreadyPresent.exitCode === 0 && alreadyPresent.stdout.trim() === expectedImageId) {
    emit(`Target already has expected image ${expectedImageId}; transfer skipped`);
    return;
  }

  // A configured registry cache is also the distribution repository. Docker
  // push/pull is content-addressed, so replicas transfer only missing layers.
  if (opts.registryRef) {
    const targetReservation = await preflightTransferDiskSpace({
      ip: targetIp,
      label: "destination import",
      imageBytes,
      archiveBytes: 0,
      includeExpandedImage: true,
      protectedImageRefs: protectedImageRefs(imageName),
      hostKey: targetHostKey,
      onProgress: emit,
    });
    const ref = artifactRef(opts.registryRef, expectedImageId);
    emit(`Registry distribution ${ref} (content-addressed missing-layer pull)`);
    let sourceAuth: Awaited<ReturnType<typeof dockerLoginGhcr>> | null = null;
    let targetAuth: Awaited<ReturnType<typeof dockerLoginGhcr>> | null = null;
    try {
      if (opts.registryUsername && opts.registryPassword) {
        sourceAuth = await dockerLoginRegistry(sourceIp, ref, opts.registryUsername, opts.registryPassword, sourceHostKey);
        targetAuth = await dockerLoginRegistry(targetIp, ref, opts.registryUsername, opts.registryPassword, targetHostKey);
      } else if (opts.registryToken && ref.startsWith("ghcr.io/")) {
        sourceAuth = await dockerLoginGhcr(sourceIp, opts.registryToken, sourceHostKey);
        targetAuth = await dockerLoginGhcr(targetIp, opts.registryToken, targetHostKey);
      }
      const pushed = await sshExecStreaming(
        sourceIp,
        `su - deploy -c ${JSON.stringify(`${sourceAuth?.envPrefix ?? ""}docker tag ${imageName} ${ref} && ${sourceAuth?.envPrefix ?? ""}docker push ${ref}`)}`,
        {
          hostKey: sourceHostKey,
          onLine: (line) => line.trim() && emit(`[registry push] ${line}`),
          onHeartbeat: (ms) => {
            void targetReservation.refresh();
            emit(`[registry push] still running (${Math.floor(ms / 1000)}s)`);
          },
        },
      );
      if (pushed.exitCode !== 0) throw new Error(describeFailure("Registry image push failed", pushed));
      const pulled = await sshExecStreaming(
        targetIp,
        `su - deploy -c ${JSON.stringify(`${targetAuth?.envPrefix ?? ""}docker pull ${ref}`)}`,
        {
          hostKey: targetHostKey,
          onLine: (line) => line.trim() && emit(`[registry pull] ${line}`),
          onHeartbeat: (ms) => {
            void targetReservation.refresh();
            emit(`[registry pull] still running (${Math.floor(ms / 1000)}s)`);
          },
        },
      );
      if (pulled.exitCode !== 0) throw new Error(describeFailure("Registry image pull failed", pulled));
      const transferredBytes = parseDockerPullTransferBytes(`${pulled.stdout}\n${pulled.stderr}`);
      opts.onStorage?.({ imageBytes, transferBytes: transferredBytes });
      if (transferredBytes !== undefined) {
        emit(`[registry pull] transferred ${(transferredBytes / 1024 / 1024).toFixed(1)} MiB of missing compressed layers`);
      } else {
        emit("[registry pull] Docker did not report an exact missing-layer byte total");
      }
      if (!imageName.startsWith("sha256:") && !imageName.includes("@sha256:")) {
        const tagged = await sshExec(
          targetIp,
          `su - deploy -c ${JSON.stringify(`docker tag ${ref} ${imageName}`)}`,
          targetHostKey,
        );
        if (tagged.exitCode !== 0) throw new Error(describeFailure("Registry image retag failed", tagged));
      }
      const verified = await sshExec(
        targetIp,
        `su - deploy -c ${JSON.stringify(`docker image inspect --format '{{.Id}}' ${expectedImageId}`)}`,
        targetHostKey,
      );
      if (verified.exitCode !== 0 || verified.stdout.trim() !== expectedImageId) {
        throw new Error(
          `Registry image verification failed: expected ${expectedImageId}, observed ${verified.stdout.trim() || "missing"}`,
        );
      }
      emit(`Registry distribution complete; Docker reused already-present layers`);
      return;
    } finally {
      await sourceAuth?.cleanup();
      await targetAuth?.cleanup();
      await targetReservation.release();
    }
  }
  if (!opts.allowArchiveFallback) {
    throw new Error(
      "No image distribution registry is configured. Multi-host archive transfer is emergency-only; " +
        "configure build.cache_ref for this app, or explicitly enable the emergency archive fallback.",
    );
  }
  const keyPath = getSshKeyPath();
  const ts = Date.now();
  const tmpFile = `/tmp/ocd-image-${ts}.tar.gz`;
  const localTmp = `${tmpdir()}/ocd-image-transfer-${ts}.tar.gz`;
  let sourceReservation: Awaited<ReturnType<typeof preflightTransferDiskSpace>> | null = null;
  let targetReservation: Awaited<ReturnType<typeof preflightTransferDiskSpace>> | null = null;

  try {
    // Conservative preflight before compression: a gzip archive can approach
    // the image's expanded size for already-compressed/binary-heavy layers.
    sourceReservation = await preflightTransferDiskSpace({
      ip: sourceIp,
      label: "source archive",
      imageBytes,
      archiveBytes: imageBytes,
      includeExpandedImage: false,
      protectedImageRefs: protectedImageRefs(imageName),
      hostKey: sourceHostKey,
      onProgress: emit,
    });
    targetReservation = await preflightTransferDiskSpace({
      ip: targetIp,
      label: "destination import",
      imageBytes,
      archiveBytes: imageBytes,
      includeExpandedImage: true,
      protectedImageRefs: protectedImageRefs(imageName),
      hostKey: targetHostKey,
      onProgress: emit,
    });

    // Save and compress on source (as deploy user who owns docker).
    // `set -o pipefail` is critical: without it, a failed `docker save` (e.g.
    // image missing on source) returns 0 because gzip happily emits an empty
    // archive, which then fails on the target with a cryptic "repositories:
    // no such file or directory" during `docker load`.
    emit(`No distribution registry configured; exporting fallback archive with fast compression`);
    const saveResult = await sshExecStreaming(
      sourceIp,
      `su - deploy -c "set -o pipefail; docker save ${imageName} | gzip -1" > ${tmpFile}`,
      {
        hostKey: sourceHostKey,
        onHeartbeat: (ms) => {
          void sourceReservation?.refresh();
          void targetReservation?.refresh();
          emit(`[archive] compression still running (${Math.floor(ms / 1000)}s)`);
        },
      },
    );
    if (saveResult.exitCode !== 0) {
      throw new Error(describeFailure("Failed to export Docker image from source server", saveResult));
    }
    // Defense in depth: if pipefail somehow didn't trip (e.g. non-bash login
    // shell), refuse to ship an obviously-empty archive.
    const sizeResult = await sshExec(sourceIp, `stat -c %s ${tmpFile} 2>/dev/null || echo 0`, sourceHostKey);
    const archiveBytes = parseInt(sizeResult.stdout.trim(), 10) || 0;
    if (archiveBytes < 1024) {
      throw new Error(`Exported image archive is suspiciously small (${archiveBytes} bytes) — image ${imageName} may not exist on the source server`);
    }
    emit(`[archive] size ${(archiveBytes / 1024 / 1024).toFixed(1)} MiB`);
    opts.onStorage?.({ imageBytes, archiveBytes, transferBytes: archiveBytes });
    // Compression has materialized the source archive, so df accounts for it;
    // no future source allocation remains. On the target, replace the
    // conservative archive estimate with the exact byte count.
    await sourceReservation.replace(0);
    await targetReservation.replace(
      archiveBytes + imageBytes + Math.ceil(imageBytes * 0.25),
    );

    // Recheck the destination with the exact archive size before transferring
    // a byte. The earlier conservative estimate catches obvious failures before
    // source compression; this check avoids retrying SCP into a full disk.
    // Download to local
    try { unlinkSync(localTmp); } catch { /* no prior partial */ }
    await scpWithProgress([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      `root@${sourceIp}:${tmpFile}`,
      localTmp,
    ], "download", archiveBytes, async () => {
      await Promise.all([sourceReservation?.refresh(), targetReservation?.refresh()]);
      try { return statSync(localTmp).size; } catch { return 0; }
    }, emit).catch((err) => {
      throw new Error(`Image download exhausted retries: ${err instanceof Error ? err.message : err}`);
    });

    // Upload to target
    await scpWithProgress([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      localTmp,
      `root@${targetIp}:${tmpFile}`,
    ], "upload", archiveBytes, async () => {
      await Promise.all([sourceReservation?.refresh(), targetReservation?.refresh()]);
      const progress = await sshExec(targetIp, `stat -c %s ${tmpFile} 2>/dev/null || echo 0`, targetHostKey);
      return parseInt(progress.stdout.trim(), 10) || 0;
    }, emit).catch((err) => {
      throw new Error(`Image upload exhausted retries: ${err instanceof Error ? err.message : err}`);
    });

    // Import retry is deliberately separate from transfer retry. A dropped SSH
    // session can outlive the remote docker load, so reconnect and inspect the
    // expected content id before deciding anything failed. If absent, replay
    // docker load from the already-uploaded archive; never rebuild/retransfer
    // while that operation-scoped archive is still usable.
    const importAttempts = 3;
    let lastImportError = "";
    for (let importAttempt = 1; importAttempt <= importAttempts; importAttempt++) {
      emit(`[archive load] attempt ${importAttempt}/${importAttempts}`);
      const loadResult = await sshExecStreaming(
        targetIp,
        `set -o pipefail; gunzip -c ${tmpFile} | su - deploy -c "docker load"`,
        {
          hostKey: targetHostKey,
          onLine: (line) => line.trim() && emit(`[archive load] ${line}`),
          onHeartbeat: (ms) => {
            void targetReservation?.refresh();
            emit(`[archive load] still running (${Math.floor(ms / 1000)}s)`);
          },
        },
      );
      if (loadResult.exitCode !== 0) {
        lastImportError = describeFailure("Docker load failed", loadResult);
        emit(`[archive load] transport/command ended non-zero; reconnecting to verify ${expectedImageId}`);
      }
      const verified = await sshExec(
        targetIp,
        `su - deploy -c ${JSON.stringify(`docker image inspect --format '{{.Id}}' ${expectedImageId}`)}`,
        targetHostKey,
      );
      if (verified.exitCode === 0 && verified.stdout.trim() === expectedImageId) {
        emit(`[archive load] verified expected image ${expectedImageId}`);
        lastImportError = "";
        break;
      }
      lastImportError ||= `expected image ${expectedImageId} is absent after docker load`;
      if (importAttempt < importAttempts) {
        emit(`[archive load] image absent; retrying import from retained archive`);
      }
    }
    if (lastImportError) {
      throw new Error(`Failed to import Docker image after ${importAttempts} attempts: ${lastImportError}`);
    }

    log("transfer", `Image ${imageName} transferred successfully`);
  } finally {
    // Cleanup remote temp files (as root, which owns them)
    await sshExec(sourceIp, `rm -f ${tmpFile}`, sourceHostKey).catch(() => { /* non-fatal cleanup */ });
    await sshExec(targetIp, `rm -f ${tmpFile}`, targetHostKey).catch(() => { /* non-fatal cleanup */ });
    try { unlinkSync(localTmp); } catch { /* file may already be gone */ }
    await sourceReservation?.release();
    await targetReservation?.release();
  }
}
