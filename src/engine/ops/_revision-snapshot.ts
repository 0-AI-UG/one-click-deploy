import { sshExec } from "../../shared/remote/index.ts";
import { asUser } from "../hetzner/container-common.ts";

export type RemoteRevisionSnapshot = {
  image: string;
  envFilePath: string | null;
};

type SnapshotTarget = {
  ip: string;
  hostKey?: string;
  appName: string;
  containerName: string;
  opId: number;
  currentImageRef: string;
};

function snapshotPaths(target: SnapshotTarget) {
  const dir = `/home/deploy/apps/${target.appName}/.ocd-revision-snapshot-${target.opId}`;
  return {
    dir,
    env: `${dir}/.env.deploy`,
    envPresent: `${dir}/env.present`,
    envAbsent: `${dir}/env.absent`,
    imageRef: `${dir}/image-ref`,
  };
}

function commandFailure(action: string, result: { exitCode: number; stdout: string; stderr: string }): Error {
  return new Error(`${action} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
}

/**
 * Record the exact registry digest and env file before a revision-changing
 * step. Recovery always pulls this digest again; it never relies on a local
 * tag, archive, build cache, or source checkout.
 */
export async function captureRemoteRevisionSnapshot(target: SnapshotTarget): Promise<RemoteRevisionSnapshot | null> {
  const paths = snapshotPaths(target);
  const inspect = await sshExec(
    target.ip,
    asUser(`docker inspect --format '{{.Image}}' ${target.containerName}`),
    target.hostKey,
  );
  if (inspect.exitCode !== 0) {
    // A missing container has no serving revision to restore. SSH/remote
    // failures use other exit codes and must stop the operation before it
    // mutates anything without a recovery point.
    if (inspect.exitCode === 1) return null;
    throw commandFailure(`Inspecting current container ${target.containerName}`, inspect);
  }
  const imageId = inspect.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    throw new Error(`Container ${target.containerName} returned an invalid immutable image id`);
  }
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(target.currentImageRef)) {
    throw new Error(`App ${target.appName} has no immutable registry image reference to snapshot`);
  }
  const snapshot = await sshExec(
    target.ip,
    asUser(
      `mkdir -p ${paths.dir} && chmod 700 ${paths.dir} && ` +
        `if test -f /home/deploy/apps/${target.appName}/.env.deploy; then ` +
        `cp /home/deploy/apps/${target.appName}/.env.deploy ${paths.env} && chmod 600 ${paths.env} && ` +
        `: > ${paths.envPresent} && rm -f ${paths.envAbsent}; else ` +
        `rm -f ${paths.env} ${paths.envPresent} && : > ${paths.envAbsent}; fi && ` +
        `printf '%s\\n' ${JSON.stringify(target.currentImageRef)} > ${paths.imageRef}`,
    ),
    target.hostKey,
  );
  if (snapshot.exitCode !== 0) throw commandFailure(`Saving revision configuration for ${target.appName}`, snapshot);

  return {
    image: target.currentImageRef,
    envFilePath: (await readSnapshotEnvState(target)) === "present" ? paths.env : null,
  };
}

async function readSnapshotEnvState(target: SnapshotTarget): Promise<"present" | "absent" | null> {
  const paths = snapshotPaths(target);
  const result = await sshExec(
    target.ip,
    asUser(
      `if test -f ${paths.envPresent} && test -f ${paths.env} && ! test -e ${paths.envAbsent}; then ` +
        `echo present; elif test -f ${paths.envAbsent} && ! test -e ${paths.envPresent} && ! test -e ${paths.env}; then ` +
        `echo absent; else exit 1; fi`,
    ),
    target.hostKey,
  );
  if (result.exitCode !== 0) return null;
  const state = result.stdout.trim();
  return state === "present" || state === "absent" ? state : null;
}

async function readSnapshotImageRef(target: SnapshotTarget): Promise<string | null> {
  const paths = snapshotPaths(target);
  const result = await sshExec(
    target.ip,
    asUser(`cat ${paths.imageRef}`),
    target.hostKey,
  );
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value === target.currentImageRef ? value : null;
}

/** Adopt only when every operation-owned recovery artifact exists. */
export async function probeRemoteRevisionSnapshot(target: SnapshotTarget): Promise<RemoteRevisionSnapshot | null> {
  const paths = snapshotPaths(target);
  const envState = await readSnapshotEnvState(target);
  if (!envState) return null;
  const imageRef = await readSnapshotImageRef(target);
  if (!imageRef) return null;
  return {
    image: imageRef,
    envFilePath: envState === "present" ? paths.env : null,
  };
}

/**
 * Remove operation-owned recovery metadata after success.
 */
export async function discardRemoteRevisionSnapshot(target: SnapshotTarget): Promise<void> {
  const paths = snapshotPaths(target);
  await sshExec(
    target.ip,
    asUser(`rm -rf ${paths.dir}`),
    target.hostKey,
  );
}
