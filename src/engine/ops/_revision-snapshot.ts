import { sshExec } from "../../shared/remote/index.ts";
import { asUser } from "../hetzner/container-common.ts";

export type RemoteRevisionSnapshot = {
  image: string;
  envFilePath: string | null;
  gitCommit: string | null;
};

type SnapshotTarget = {
  ip: string;
  hostKey?: string;
  appName: string;
  containerName: string;
  opId: number;
  sourceMode: string;
};

function snapshotPaths(target: SnapshotTarget) {
  const dir = `/home/deploy/apps/${target.appName}/.ocd-revision-snapshot-${target.opId}`;
  return {
    dir,
    env: `${dir}/.env.deploy`,
    envPresent: `${dir}/env.present`,
    envAbsent: `${dir}/env.absent`,
    gitHead: `${dir}/git-head`,
    gitAbsent: `${dir}/git.absent`,
    // Build GC deliberately protects only :latest and :rollback. The app
    // resource lock serializes revision operations, while the env/git files
    // remain operation-scoped for exact crash-resume adoption.
    image: `${target.appName}:rollback`,
  };
}

function commandFailure(action: string, result: { exitCode: number; stdout: string; stderr: string }): Error {
  return new Error(`${action} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
}

/**
 * Pin the currently running image and copy the exact env file/git HEAD before
 * a revision-changing step. All names are operation-scoped, so retrying this
 * incomplete step is safe. The app-scoped rollback tag is protected by build
 * GC; operation-scoped metadata prevents a new op from adopting an old tag.
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

  const pin = await sshExec(target.ip, asUser(`docker tag ${imageId} ${paths.image}`), target.hostKey);
  if (pin.exitCode !== 0) throw commandFailure(`Pinning current image for ${target.appName}`, pin);

  let gitCommit: string | null = null;
  if (target.sourceMode !== "image") {
    const head = await sshExec(
      target.ip,
      asUser(`cd /home/deploy/apps/${target.appName} && git rev-parse HEAD`),
      target.hostKey,
    );
    if (head.exitCode !== 0) throw commandFailure(`Capturing current Git revision for ${target.appName}`, head);
    gitCommit = head.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(gitCommit)) {
      throw new Error(`Repository for ${target.appName} returned an invalid Git revision`);
    }
  }

  const gitMarker = gitCommit
    ? `printf '%s\\n' ${gitCommit} > ${paths.gitHead} && rm -f ${paths.gitAbsent}`
    : `rm -f ${paths.gitHead} && : > ${paths.gitAbsent}`;
  const snapshot = await sshExec(
    target.ip,
    asUser(
      `mkdir -p ${paths.dir} && chmod 700 ${paths.dir} && ` +
        `if test -f /home/deploy/apps/${target.appName}/.env.deploy; then ` +
        `cp /home/deploy/apps/${target.appName}/.env.deploy ${paths.env} && chmod 600 ${paths.env} && ` +
        `: > ${paths.envPresent} && rm -f ${paths.envAbsent}; else ` +
        `rm -f ${paths.env} ${paths.envPresent} && : > ${paths.envAbsent}; fi && ${gitMarker}`,
    ),
    target.hostKey,
  );
  if (snapshot.exitCode !== 0) throw commandFailure(`Saving revision configuration for ${target.appName}`, snapshot);

  return {
    image: paths.image,
    envFilePath: (await readSnapshotEnvState(target)) === "present" ? paths.env : null,
    gitCommit,
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

async function readSnapshotGitState(target: SnapshotTarget): Promise<string | null | undefined> {
  const paths = snapshotPaths(target);
  const result = await sshExec(
    target.ip,
    asUser(
      `if test -f ${paths.gitHead} && ! test -e ${paths.gitAbsent}; then cat ${paths.gitHead}; ` +
        `elif test -f ${paths.gitAbsent} && ! test -e ${paths.gitHead}; then echo absent; else exit 1; fi`,
    ),
    target.hostKey,
  );
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  if (value === "absent") return null;
  return /^[a-f0-9]{40,64}$/i.test(value) ? value : undefined;
}

/** Adopt only when every operation-owned recovery artifact exists. */
export async function probeRemoteRevisionSnapshot(target: SnapshotTarget): Promise<RemoteRevisionSnapshot | null> {
  const paths = snapshotPaths(target);
  const image = await sshExec(
    target.ip,
    asUser(`docker image inspect --format '{{.Id}}' ${paths.image}`),
    target.hostKey,
  );
  if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/i.test(image.stdout.trim())) return null;
  const envState = await readSnapshotEnvState(target);
  if (!envState) return null;
  const gitCommit = await readSnapshotGitState(target);
  if (gitCommit === undefined) return null;
  if (target.sourceMode === "image" ? gitCommit !== null : gitCommit === null) return null;
  return {
    image: paths.image,
    envFilePath: envState === "present" ? paths.env : null,
    gitCommit,
  };
}

export async function restoreSnapshotGitCheckout(target: SnapshotTarget, gitCommit: string | null): Promise<void> {
  if (!gitCommit) return;
  const result = await sshExec(
    target.ip,
    asUser(`cd /home/deploy/apps/${target.appName} && git checkout ${gitCommit}`),
    target.hostKey,
  );
  if (result.exitCode !== 0) throw commandFailure(`Restoring Git revision for ${target.appName}`, result);
}

/**
 * Remove operation-owned env/Git metadata after success. Keep the app-scoped
 * :rollback tag as the single last-known-good image protected by host GC; the
 * next serialized revision operation replaces it.
 */
export async function discardRemoteRevisionSnapshot(target: SnapshotTarget): Promise<void> {
  const paths = snapshotPaths(target);
  await sshExec(
    target.ip,
    asUser(`rm -rf ${paths.dir}`),
    target.hostKey,
  );
}
