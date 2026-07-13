import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { sshExec, getSshKeyPath, describeFailure } from "./ssh.ts";
import { log } from "./container-common.ts";

export async function transferImage(
  sourceIp: string,
  targetIp: string,
  imageName: string,
  sourceHostKey?: string,
  targetHostKey?: string
): Promise<void> {
  log("transfer", `Transferring image ${imageName} from ${sourceIp} to ${targetIp}`);
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
    const saveResult = await sshExec(
      sourceIp,
      `su - deploy -c "set -o pipefail; docker save ${imageName} | gzip" > ${tmpFile}`,
      sourceHostKey
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

    // Download to local
    const scpDown = Bun.spawn([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      `root@${sourceIp}:${tmpFile}`,
      localTmp,
    ], { stdout: "pipe", stderr: "pipe" });
    const downExit = await scpDown.exited;
    if (downExit !== 0) {
      const stderr = await new Response(scpDown.stderr).text();
      const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) || `exit ${downExit}`;
      throw new Error(`Failed to download image from source server: ${detail}`);
    }

    // Upload to target
    const scpUp = Bun.spawn([
      "scp", "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=30",
      localTmp,
      `root@${targetIp}:${tmpFile}`,
    ], { stdout: "pipe", stderr: "pipe" });
    const upExit = await scpUp.exited;
    if (upExit !== 0) {
      const stderr = await new Response(scpUp.stderr).text();
      const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400) || `exit ${upExit}`;
      throw new Error(`Failed to upload image to target server: ${detail}`);
    }

    // Load on target — run docker load as deploy, but file is owned by root
    // So: gunzip as root, pipe to deploy's docker load
    const loadResult = await sshExec(
      targetIp,
      `gunzip -c ${tmpFile} | su - deploy -c "docker load"`,
      targetHostKey
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
