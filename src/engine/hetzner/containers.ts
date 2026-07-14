// Barrel module: the container/build/health/service helpers were split
// into per-concern modules (see the sibling files below). This file re-exports
// the same public surface so existing importers (shared/remote, tests) keep the
// concrete `hetzner/containers.ts` path.

export {
  OCD_IMAGE_LABEL_KEY,
  OCD_IMAGE_LABEL,
  DEFAULT_MEM_MB,
  DEFAULT_CPUS,
  DEFAULT_PIDS,
  buildDockerRunArgs,
} from "./container-common.ts";
export type { DockerRunVolume, DockerRunOpts } from "./container-common.ts";

export type { GhcrAuth } from "./registry.ts";

export { writeEnvDeployFile, startAppReplica } from "./docker-run.ts";
export type { StartAppReplicaOpts } from "./docker-run.ts";

export { pruneAfterBuild, pruneServer } from "./prune.ts";

export { transferImage } from "./image-transfer.ts";

export { findDockerfile, buildAppImage, cloneRepo, cloneAndBuild } from "./build.ts";

export {
  healthCheck,
  containerRunningCheck,
  probeAppHealth,
  serviceHealthCheck,
} from "./health.ts";

export {
  removeContainer,
  getContainerLogs,
  restartContainer,
  pauseContainer,
  unpauseContainer,
  stopContainer,
  startContainer,
  containerExists,
  containerRunning,
  ensureOcdNetwork,
} from "./lifecycle.ts";

export { pullAndRunService, deployConfigFile } from "./infra.ts";
