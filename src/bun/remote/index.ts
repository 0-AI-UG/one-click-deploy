// Provider-agnostic remote server utilities.
// These operate over SSH on any Linux server — they are not tied to any cloud provider.

// SSH & server access
export {
  sshExec,
  getSshKeyPath,
  getOrCreateLocalKeyPair,
  captureHostKey,
  waitForServer,
} from "../hetzner/ssh.ts";

// SSH PTY (interactive terminal)
export { spawnSshPty, type PtySession } from "../hetzner/ssh-pty.ts";

// Containers (Caddy, Docker, Compose, Railpack, health checks)
export {
  deployCaddySite,
  deployCaddyWakePage,
  removeCaddySite,
  checkCaddyRoute,
  cloneAndBuild,
  cloneAndRailpackBuild,
  removeContainer,
  detectComposeFile,
  detectWebService,
  cloneAndComposeBuild,
  restartCompose,
  pauseCompose,
  unpauseCompose,
  removeCompose,
  getComposeLogs,
  composeHealthCheck,
  healthCheck,
  getContainerLogs,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  transferImage,
  ensureOcdNetwork,
  pullAndRunService,
  serviceHealthCheck,
  deployConfigFile,
} from "../hetzner/containers.ts";

// Auth proxy
export {
  authProxyPort,
  deployAuthProxy,
  removeAuthProxy,
} from "../hetzner/auth-proxy.ts";

// Scale daemon
export {
  deployScaleDaemon,
  updateScaleDaemonConfig,
  removeScaleDaemon,
} from "../hetzner/scale-daemon.ts";
