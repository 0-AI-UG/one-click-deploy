// Provider-agnostic remote server utilities.
// These operate over SSH on any Linux server — they are not tied to any cloud provider.

// SSH & server access
export {
  sshExec,
  getSshKeyPath,
  getOrCreateLocalKeyPair,
  captureHostKey,
  waitForServer,
} from "../../engine/hetzner/ssh.ts";

// SSH PTY (interactive terminal)
export { spawnSshPty, type PtySession } from "../../engine/hetzner/ssh-pty.ts";

// Containers (Docker, health checks)
export {
  cloneRepo,
  cloneAndBuild,
  removeContainer,
  healthCheck,
  containerRunningCheck,
  probeAppHealth,
  startAppReplica,
  writeEnvDeployFile,
  buildAppImage,
  findDockerfile,
  getContainerLogs,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  stopContainer,
  startContainer,
  containerExists,
  containerRunning,
  transferImage,
  ensureOcdNetwork,
  buildDockerRunArgs,
  pullAndRunService,
  serviceHealthCheck,
  deployConfigFile,
  pruneServer,
} from "../../engine/hetzner/containers.ts";

