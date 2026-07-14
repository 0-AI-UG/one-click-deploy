import { sshExec, describeFailure } from "./ssh.ts";
import { asUser } from "./container-common.ts";

export async function removeContainer(ip: string, name: string, hostKey?: string) {
  await sshExec(ip, asUser(`docker rm -f ${name} 2>/dev/null || true`), hostKey);
}

// --- Container Logs ---

export async function getContainerLogs(
  ip: string,
  containerName: string,
  tail: number = 100,
  hostKey?: string
): Promise<string> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker logs --tail ${tail} ${containerName} 2>&1"`,
    hostKey
  );
  return result.stdout;
}

// --- Container Restart / Pause / Unpause ---

export async function restartContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    asUser(`docker restart ${containerName}`),
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(describeFailure("Failed to restart container", result));
  }
}

export async function pauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    asUser(`docker pause ${containerName}`),
    hostKey
  );
  if (result.exitCode !== 0) {
    // Idempotent: the DB status can lag the actual container state (e.g. a
    // crashed op or manual intervention), so pausing twice must not fail.
    if (`${result.stdout}\n${result.stderr}`.toLowerCase().includes("already paused")) return;
    throw new Error(describeFailure("Failed to pause container", result));
  }
}

export async function unpauseContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<void> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker unpause ${containerName}"`,
    hostKey
  );
  if (result.exitCode !== 0) {
    // Idempotent: unpausing a container that is running but not frozen
    // (DB said paused, container was not) must not fail the op.
    if (`${result.stdout}\n${result.stderr}`.toLowerCase().includes("is not paused")) return;
    throw new Error(describeFailure("Failed to unpause container", result));
  }
}

/**
 * `docker stop <name>` — stops the container but preserves its filesystem,
 * volume mounts, and config. Used for scale-to-zero so that a subsequent
 * `docker start` can bring it back up in ~1s without re-running `docker run`.
 * Returns true if the container was stopped (or already stopped), false if it
 * didn't exist.
 */
export async function stopContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    asUser(`docker stop ${containerName} 2>&1`),
    hostKey
  );
  if (result.exitCode === 0) return true;
  // `docker stop` on a nonexistent container prints "No such container"
  if (/No such container/i.test(result.stdout + result.stderr)) return false;
  throw new Error(`Failed to stop container ${containerName}: ${result.stderr || result.stdout}`);
}

/**
 * `docker start <name>` — starts a previously stopped container. Returns true
 * if started, false if the container doesn't exist (caller should fall back
 * to the full `docker run` path).
 */
export async function startContainer(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    asUser(`docker start ${containerName} 2>&1`),
    hostKey
  );
  if (result.exitCode === 0) return true;
  if (/No such container/i.test(result.stdout + result.stderr)) return false;
  throw new Error(`Failed to start container ${containerName}: ${result.stderr || result.stdout}`);
}

/** Returns true iff a container with this name exists on the host (running or stopped). */
export async function containerExists(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker inspect ${containerName} >/dev/null 2>&1 && echo yes || echo no"`,
    hostKey
  );
  return result.stdout.trim() === "yes";
}

/** Returns true iff a container with this name exists AND is currently running
 * (`State.Running == true`). A stopped/exited/created container returns false —
 * callers that adopt a container on resume must not adopt a dead one. */
export async function containerRunning(
  ip: string,
  containerName: string,
  hostKey?: string
): Promise<boolean> {
  const result = await sshExec(
    ip,
    `su - deploy -c "docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null"`,
    hostKey
  );
  return result.stdout.trim() === "true";
}

// --- Docker Network for Services ---

export async function ensureOcdNetwork(ip: string, hostKey?: string): Promise<void> {
  await sshExec(
    ip,
    `su - deploy -c "docker network inspect ocd-net >/dev/null 2>&1 || docker network create ocd-net"`,
    hostKey
  );
}
