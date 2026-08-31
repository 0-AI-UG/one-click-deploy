// Provider-agnostic remote server utilities.
// These operate over SSH on any Linux server — they are not tied to any cloud provider.

// SSH & server access
export {
  sshExec,
  sshExecStreaming,
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
  pullAndRunService,
  serviceHealthCheck,
  deployConfigFile,
  pruneServer,
  ensureHostLogPolicy,
} from "../../engine/hetzner/containers.ts";
