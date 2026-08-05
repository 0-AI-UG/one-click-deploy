import { statSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { sshExec, sshExecStreaming, getSshKeyPath, describeFailure } from "./ssh.ts";
import { log } from "./container-common.ts";
import { dockerLoginGhcr } from "./registry.ts";

export type ImageTransferProgress = (line: string) => void;

function artifactRef(cacheRef: string, imageId: string): string {
  const lastSlash = cacheRef.lastIndexOf("/");
  const lastColon = cacheRef.lastIndexOf(":");
  const repo = lastColon > lastSlash ? cacheRef.slice(0, lastColon) : cacheRef;
  return `${repo}:ocd-${imageId.replace(/^sha256:/, "").slice(0, 32)}`;
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
  opts: { registryRef?: string; registryToken?: string; onProgress?: ImageTransferProgress; attempt?: number } = {},
): Promise<void> {
  const emit = opts.onProgress ?? (() => {});
  const attempt = opts.attempt ?? 1;
  log("transfer", `attempt ${attempt}: ensuring image ${imageName} from ${sourceIp} on ${targetIp}`);
  emit(`Image transfer attempt ${attempt}: ${imageName}`);

  // A configured registry cache is also the distribution repository. Docker
  // push/pull is content-addressed, so replicas transfer only missing layers.
  if (opts.registryRef) {
    const inspect = await sshExec(sourceIp, `su - deploy -c ${JSON.stringify(`docker image inspect --format '{{.Id}}' ${imageName}`)}`, sourceHostKey);
    if (inspect.exitCode !== 0 || !inspect.stdout.trim()) {
      throw new Error(describeFailure("Image distribution preflight failed", inspect));
    }
    const ref = artifactRef(opts.registryRef, inspect.stdout.trim());
    emit(`Registry distribution ${ref} (content-addressed missing-layer pull)`);
    let sourceAuth: Awaited<ReturnType<typeof dockerLoginGhcr>> | null = null;
    let targetAuth: Awaited<ReturnType<typeof dockerLoginGhcr>> | null = null;
    try {
      if (opts.registryToken && ref.startsWith("ghcr.io/")) {
        sourceAuth = await dockerLoginGhcr(sourceIp, opts.registryToken, sourceHostKey);
        targetAuth = await dockerLoginGhcr(targetIp, opts.registryToken, targetHostKey);
      }
      const pushed = await sshExecStreaming(
        sourceIp,
        `su - deploy -c ${JSON.stringify(`${sourceAuth?.envPrefix ?? ""}docker tag ${imageName} ${ref} && ${sourceAuth?.envPrefix ?? ""}docker push ${ref}`)}`,
        {
          hostKey: sourceHostKey,
          onLine: (line) => line.trim() && emit(`[registry push] ${line}`),
          onHeartbeat: (ms) => emit(`[registry push] still running (${Math.floor(ms / 1000)}s)`),
        },
      );
      if (pushed.exitCode !== 0) throw new Error(describeFailure("Registry image push failed", pushed));
      const pulled = await sshExecStreaming(
        targetIp,
        `su - deploy -c ${JSON.stringify(`${targetAuth?.envPrefix ?? ""}docker pull ${ref}`)}`,
        {
          hostKey: targetHostKey,
          onLine: (line) => line.trim() && emit(`[registry pull] ${line}`),
          onHeartbeat: (ms) => emit(`[registry pull] still running (${Math.floor(ms / 1000)}s)`),
        },
      );
      if (pulled.exitCode !== 0) throw new Error(describeFailure("Registry image pull failed", pulled));
      if (!imageName.startsWith("sha256:") && !imageName.includes("@sha256:")) {
        const tagged = await sshExec(
          targetIp,
          `su - deploy -c ${JSON.stringify(`docker tag ${ref} ${imageName}`)}`,
          targetHostKey,
        );
        if (tagged.exitCode !== 0) throw new Error(describeFailure("Registry image retag failed", tagged));
      }
      emit(`Registry distribution complete; Docker reused already-present layers`);
      return;
    } finally {
      await sourceAuth?.cleanup();
      await targetAuth?.cleanup();
    }
  }
  const keyPath = getSshKeyPath();
  const ts = Date.now();
  const tmpFile = `/tmp/ocd-image-${ts}.tar.gz`;
  const localTmp = `${tmpdir()}/ocd-image-transfer-${ts}.tar.gz`;

  try {
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
        onHeartbeat: (ms) => emit(`[archive] compression still running (${Math.floor(ms / 1000)}s)`),
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

    // Download to local
    try { unlinkSync(localTmp); } catch { /* no prior partial */ }
    await scpWithProgress([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      `root@${sourceIp}:${tmpFile}`,
      localTmp,
    ], "download", archiveBytes, async () => {
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
      const progress = await sshExec(targetIp, `stat -c %s ${tmpFile} 2>/dev/null || echo 0`, targetHostKey);
      return parseInt(progress.stdout.trim(), 10) || 0;
    }, emit).catch((err) => {
      throw new Error(`Image upload exhausted retries: ${err instanceof Error ? err.message : err}`);
    });

    // Load on target — run docker load as deploy, but file is owned by root
    // So: gunzip as root, pipe to deploy's docker load
    const loadResult = await sshExecStreaming(
      targetIp,
      `gunzip -c ${tmpFile} | su - deploy -c "docker load"`,
      {
        hostKey: targetHostKey,
        onLine: (line) => line.trim() && emit(`[archive load] ${line}`),
        onHeartbeat: (ms) => emit(`[archive load] still running (${Math.floor(ms / 1000)}s)`),
      },
    );
    if (loadResult.exitCode !== 0) {
      throw new Error(describeFailure("Failed to import Docker image on target server", loadResult));
    }

    log("transfer", `Image ${imageName} transferred successfully`);
  } finally {
    // Cleanup remote temp files (as root, which owns them)
    await sshExec(sourceIp, `rm -f ${tmpFile}`, sourceHostKey).catch(() => { /* non-fatal cleanup */ });
    await sshExec(targetIp, `rm -f ${tmpFile}`, targetHostKey).catch(() => { /* non-fatal cleanup */ });
    try { unlinkSync(localTmp); } catch { /* file may already be gone */ }
  }
}
