// Bind-mount management for Hetzner-attached volumes.
//
// Background: Hetzner attaches volumes with `automount: true`, which lands the
// real device at `/mnt/HC_Volume_${volumeId}`. Apps and services historically
// referenced `/mnt/ocd-${name}-data` on the root filesystem, so Docker bind
// mounts silently wrote to the root disk instead of the persistent volume.
//
// The fix is to layer a bind mount from `/mnt/HC_Volume_${volumeId}` onto the
// `/mnt/ocd-*-data` path used by Docker, persisted via a tagged fstab block so
// it survives reboot.
//
// Block-name convention used by callers:
//   - user apps:  `app-${app.id}`
//   - services:   `svc-${service.id}`

import { sshExec } from "./ssh.ts";

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:host-mounts]`, ...args);
}

const BLOCK_BEGIN = (name: string) => `# BEGIN ocd-bind ${name}`;
const BLOCK_END = (name: string) => `# END ocd-bind ${name}`;

function hetznerMountPath(volumeId: string | number): string {
  return `/mnt/HC_Volume_${volumeId}`;
}

function fstabLine(volumeId: string | number, hostMountPath: string): string {
  const hc = hetznerMountPath(volumeId);
  // `nofail` so a missing/detached volume doesn't block boot; the
  // `x-systemd.requires` directive defers the bind until systemd has
  // mounted the underlying Hetzner volume.
  return `${hc}  ${hostMountPath}  none  bind,nofail,x-systemd.requires=${hc}  0 0`;
}

export function buildFstabBlock(opts: {
  blockName: string;
  hetznerVolumeId: string | number;
  hostMountPath: string;
}): string {
  return [
    BLOCK_BEGIN(opts.blockName),
    fstabLine(opts.hetznerVolumeId, opts.hostMountPath),
    BLOCK_END(opts.blockName),
  ].join("\n");
}

async function exec(serverIp: string, hostKey: string | undefined, cmd: string) {
  return sshExec(serverIp, cmd, hostKey);
}

export type EnsureOpts = {
  serverIp: string;
  hostKey?: string;
  hetznerVolumeId: string | number;
  hostMountPath: string;
  blockName: string;
  /** How long to wait for the Hetzner automount to settle (default 60s). */
  mountWaitMs?: number;
  /** Poll interval while waiting for the mount (default 2s). */
  mountPollMs?: number;
};

/**
 * Make sure `hostMountPath` is bound to `/mnt/HC_Volume_${hetznerVolumeId}`
 * and that the bind is persisted in /etc/fstab (idempotent, tagged block).
 *
 * Throws when the Hetzner volume isn't actually mounted on the server — that
 * usually means the attach/automount hasn't settled and the caller should
 * back off or retry rather than papering over the failure.
 */
export async function ensureVolumeBindMount(opts: EnsureOpts): Promise<void> {
  const { serverIp, hostKey, hetznerVolumeId, hostMountPath, blockName } = opts;
  const hc = hetznerMountPath(hetznerVolumeId);
  const MOUNT_WAIT_MS = opts.mountWaitMs ?? 60_000;
  const POLL_MS = opts.mountPollMs ?? 2_000;

  // 1. Wait for the Hetzner volume to be mounted (findmnt prints the source
  //    device). The volume-attach API returns before systemd's automount unit
  //    has necessarily settled — especially on a freshly-booted server — so
  //    poll with a bounded backoff rather than probing once and failing on a
  //    race the caller can't otherwise recover from.
  const deadline = Date.now() + MOUNT_WAIT_MS;
  let attempts = 0;
  for (;;) {
    const probe = await exec(serverIp, hostKey, `findmnt -no SOURCE ${hc} || true`);
    if (probe.stdout.trim()) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Hetzner volume not mounted at ${hc} on ${serverIp} after ${MOUNT_WAIT_MS / 1000}s ` +
          `(${attempts} probes) — attach + automount may not have settled. Re-check the ` +
          `volume's attachment in the Hetzner console and retry once cloud-init / systemd has settled.`,
      );
    }
    if (attempts === 0) log(`waiting for ${hc} to mount on ${serverIp}...`);
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // 2. Make the bind target directory and own it to deploy.
  await exec(
    serverIp,
    hostKey,
    `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`,
  );

  // 3. If something is already bound there from the same Hetzner volume,
  // we're done with the runtime mount.
  const current = await exec(serverIp, hostKey, `findmnt -no SOURCE ${hostMountPath} || true`);
  const currentSrc = current.stdout.trim();
  const alreadyBound = currentSrc.length > 0 && (currentSrc === hc || currentSrc.startsWith(`${hc}[`));
  if (alreadyBound) {
    log(`bind already in place: ${hostMountPath} -> ${hc}`);
  } else {
    if (currentSrc.length > 0) {
      // Different device mounted there — log it and proceed; mount --bind will
      // stack on top, which is what we want.
      log(`warning: ${hostMountPath} already has source ${currentSrc}; stacking bind from ${hc}`);
    }
    const bind = await exec(serverIp, hostKey, `mount --bind ${hc} ${hostMountPath}`);
    if (bind.exitCode !== 0) {
      throw new Error(
        `mount --bind ${hc} -> ${hostMountPath} failed (exit ${bind.exitCode}): ${bind.stderr.trim() || bind.stdout.trim()}`,
      );
    }
    log(`mounted ${hostMountPath} -> ${hc}`);
  }

  // 4. Rewrite (or insert) the tagged fstab block. Delete-then-append for
  // idempotency; the JSON-escaped heredoc avoids shell-quoting pitfalls.
  const begin = BLOCK_BEGIN(blockName);
  const end = BLOCK_END(blockName);
  const line = fstabLine(hetznerVolumeId, hostMountPath);
  const sedExpr = `/${begin.replace(/[/]/g, "\\/")}/,/${end.replace(/[/]/g, "\\/")}/d`;
  // Single shell command so a crash mid-update can't leave a half-deleted block.
  const fstabCmd = [
    `sed -i '${sedExpr}' /etc/fstab`,
    `printf '%s\\n%s\\n%s\\n' ${JSON.stringify(begin)} ${JSON.stringify(line)} ${JSON.stringify(end)} >> /etc/fstab`,
  ].join(" && ");
  const fstab = await exec(serverIp, hostKey, fstabCmd);
  if (fstab.exitCode !== 0) {
    throw new Error(
      `updating /etc/fstab block "${blockName}" failed (exit ${fstab.exitCode}): ${fstab.stderr.trim() || fstab.stdout.trim()}`,
    );
  }

  // 5. systemd reads fstab via generators — daemon-reload picks up the change
  // so a reboot, or a `systemctl restart local-fs.target`, will honor it.
  await exec(serverIp, hostKey, `systemctl daemon-reload`);
}

export type RemoveOpts = {
  serverIp: string;
  hostKey?: string;
  hostMountPath: string;
  blockName: string;
};

/**
 * Best-effort teardown of a bind mount + its fstab block. Never throws — we
 * log and continue so the caller can proceed with detach/destroy even if
 * unmount races with a still-open file. Returns nothing.
 */
export async function removeVolumeBindMount(opts: RemoveOpts): Promise<void> {
  const { serverIp, hostKey, hostMountPath, blockName } = opts;

  try {
    const u = await exec(serverIp, hostKey, `umount ${hostMountPath} 2>&1 || true`);
    const out = (u.stdout + u.stderr).toLowerCase();
    if (out.includes("busy")) {
      log(`umount ${hostMountPath} returned busy; falling back to lazy umount`);
      try {
        await exec(serverIp, hostKey, `umount -l ${hostMountPath} 2>&1 || true`);
      } catch (err) {
        log(`lazy umount also failed (continuing): ${err}`);
      }
    }
  } catch (err) {
    log(`umount ${hostMountPath} threw (continuing): ${err}`);
  }

  try {
    const begin = BLOCK_BEGIN(blockName);
    const end = BLOCK_END(blockName);
    const sedExpr = `/${begin.replace(/[/]/g, "\\/")}/,/${end.replace(/[/]/g, "\\/")}/d`;
    await exec(serverIp, hostKey, `sed -i '${sedExpr}' /etc/fstab`);
    await exec(serverIp, hostKey, `systemctl daemon-reload || true`);
  } catch (err) {
    log(`fstab cleanup for ${blockName} failed (continuing): ${err}`);
  }

  try {
    await exec(serverIp, hostKey, `rmdir ${hostMountPath} 2>/dev/null || true`);
  } catch (err) {
    log(`rmdir ${hostMountPath} failed (continuing): ${err}`);
  }
}

export type StatusOpts = {
  serverIp: string;
  hostKey?: string;
  hostMountPath: string;
};

export type BindStatus = {
  mounted: boolean;
  sourceDevice: string | null;
  fstabPresent: boolean;
};

/**
 * Probe the current bind status without mutating anything. Useful for
 * migration scripts and operational diagnostics.
 */
export async function bindMountStatus(opts: StatusOpts): Promise<BindStatus> {
  const { serverIp, hostKey, hostMountPath } = opts;

  const mountProbe = await exec(serverIp, hostKey, `findmnt -no SOURCE ${hostMountPath} 2>/dev/null || true`);
  const sourceDevice = mountProbe.stdout.trim() || null;

  const fstabProbe = await exec(serverIp, hostKey, `grep -q "# BEGIN ocd-bind" /etc/fstab && echo yes || echo no`);
  const fstabPresent = fstabProbe.stdout.trim() === "yes";

  return {
    mounted: sourceDevice !== null,
    sourceDevice,
    fstabPresent,
  };
}
