// Provider-agnostic remote server utilities.
// These operate over SSH on any Linux server — they are not tied to any cloud provider.

// SSH & server access
export {
  sshExec,
  sshExecStreaming,
  sshExecWithStdin,
  buildSshArgs,
  writeKnownHostsTmp,
  getSshKeyPath,
  getOrCreateLocalKeyPair,
  captureHostKey,
  waitForServer,
} from "../../engine/hetzner/ssh.ts";

// SSH PTY (interactive terminal)
export { spawnSshPty, type PtySession } from "../../engine/hetzner/ssh-pty.ts";

// Containers (Docker, health checks)
export {
  pullImmutableImageAndRun,
  pullImmutableImage,
  removeContainer,
  healthCheck,
  containerRunningCheck,
  probeAppHealth,
  markerFreshnessHealthCheck,
  assessMarkerFreshness,
  startAppReplica,
  runAppPostStartCommand,
  writeEnvDeployFile,
  getContainerLogs,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  stopContainer,
  startContainer,
  containerExists,
  containerRunning,
  ensureOcdNetwork,
  buildDockerRunArgs,
  pruneServer,
  ensureHostLogPolicy,
} from "../../engine/hetzner/containers.ts";

export { dockerLoginRegistry, type RegistryAuth } from "../../engine/hetzner/registry.ts";
export { asUser, DEFAULT_LOG_MAX_FILES, DEFAULT_LOG_MAX_SIZE } from "../../engine/hetzner/container-common.ts";
export { inspectServerGc, garbageCollectServer } from "../../engine/hetzner/prune.ts";
