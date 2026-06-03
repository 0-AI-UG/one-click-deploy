// Provider-agnostic remote server utilities.
// These operate over SSH on any Linux server — they are not tied to any cloud provider.

// SSH & server access
export {
  sshExec,
  getSshKeyPath,
  getOrCreateLocalKeyPair,
  captureHostKey,
  waitForServer,
  describeFailure,
} from "../../engine/hetzner/ssh.ts";

// SSH PTY (interactive terminal)
export { spawnSshPty, type PtySession } from "../../engine/hetzner/ssh-pty.ts";

// Containers (Caddy, Docker, Compose, Railpack, health checks)
export {
  deployCaddySite,
  deployCaddyWakePage,
  removeCaddyWakePage,
  cloneRepo,
  cloneAndBuild,
  cloneAndRailpackBuild,
  removeContainer,
  detectComposeFile,
  detectWebService,
  cloneAndComposeBuild,
  restartCompose,
  pauseCompose,
  unpauseCompose,
  stopCompose,
  startCompose,
  composeProjectExists,
  removeCompose,
  getComposeLogs,
  composeHealthCheck,
  healthCheck,
  getContainerLogs,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  stopContainer,
  startContainer,
  containerExists,
  transferImage,
  ensureOcdNetwork,
  buildDockerRunArgs,
  pullAndRunService,
  pullAndRunComposeService,
  serviceHealthCheck,
  deployConfigFile,
  pruneServer,
} from "../../engine/hetzner/containers.ts";

// Auth proxy
export {
  authProxyPort,
  deployAuthProxy,
  removeAuthProxy,
} from "../../engine/hetzner/auth-proxy.ts";

