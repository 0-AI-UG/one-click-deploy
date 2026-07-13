import { sshExec, describeFailure } from "./ssh.ts";
import { asUser, log, OCD_IMAGE_LABEL } from "./container-common.ts";
import { dockerLoginGhcr, type GhcrAuth } from "./registry.ts";
import { startAppReplica } from "./docker-run.ts";
import { ensureOcdNetwork } from "./lifecycle.ts";
import { pruneAfterBuild } from "./prune.ts";

/**
 * Conventional Dockerfile probe: prefer ./Dockerfile, then ./docker/Dockerfile,
 * else the first Dockerfile within three levels. Shared by cloneAndBuild and the
 * rollback rebuild so both discover the same path. Returns "" when none found.
 */
export async function findDockerfile(ip: string, appDir: string, hostKey?: string): Promise<string> {
  const result = await sshExec(
    ip,
    asUser(`cd ${appDir} && if [ -f Dockerfile ]; then echo Dockerfile; elif [ -f docker/Dockerfile ]; then echo docker/Dockerfile; else find . -maxdepth 3 -name Dockerfile -type f | head -1 | sed 's|^\\./||'; fi`),
    hostKey,
  );
  return result.stdout.trim();
}

/**
 * Run `docker build` for an app image. Always applies the OCD_IMAGE_LABEL so the
 * scoped prune (pruneAfterBuild/pruneServer) can reclaim it — the single choke
 * point that guarantees no build path (deploy OR rollback) can orphan an image.
 */
export async function buildAppImage(
  ip: string,
  opts: {
    appDir: string;
    imageTag: string;
    dockerfilePath: string;
    dockerContext?: string;
    /** Prefix for ephemeral ghcr.io DOCKER_CONFIG creds (trailing space included). */
    envPrefix?: string;
  },
  hostKey?: string,
): Promise<void> {
  const dockerContext = opts.dockerContext || ".";
  const buildCmd = `cd ${opts.appDir} && ${opts.envPrefix ?? ""}docker build --label ${OCD_IMAGE_LABEL} -t ${opts.imageTag} -f ${opts.dockerfilePath} ${dockerContext}`;
  log("build", `Docker build command: ${buildCmd}`);
  const result = await sshExec(ip, asUser(buildCmd), hostKey);
  if (result.exitCode !== 0) {
    log("build", `Docker build stderr: ${result.stderr.slice(0, 500)}`);
    throw new Error(describeFailure("Docker build failed", result));
  }
}

// Shared git clone/pull logic used by cloneAndBuild.
export async function cloneRepo(
  ip: string,
  appName: string,
  gitRepo: string,
  gitToken?: string,
  emit?: (msg: string) => void,
  gitBranch?: string,
  hostKey?: string,
) {
  const appDir = `/home/deploy/apps/${appName}`;

  let cloneUrl = gitRepo;
  if (gitToken && cloneUrl.match(/^https:\/\/github\.com\//)) {
    cloneUrl = cloneUrl.replace(
      /^https:\/\/github\.com\//,
      `https://x-access-token:${gitToken}@github.com/`
    );
  }

  const branchFlag = gitBranch ? ` -b ${gitBranch}` : "";
  emit?.("Cloning repository...");
  log("build", `Cloning ${gitRepo} into ${appDir} (token: ${gitToken ? "yes" : "no"}, branch: ${gitBranch || "default"})`);
  // Ensure the app dir (if it exists) is owned by deploy so the subsequent
  // rm -rf/git clone/pull works even if a prior root-run step (e.g. scaleUp
  // writing .env.deploy) left root-owned files behind.
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps && mkdir -p ${appDir} && chown -R deploy:deploy ${appDir}`, hostKey);
  const gitEnv = gitToken ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
  const cloneResult = await sshExec(
    ip,
    asUser(`${gitEnv}if [ -d "${appDir}/.git" ]; then cd ${appDir} && git remote set-url origin ${cloneUrl} && git fetch origin && git checkout ${gitBranch || "HEAD"} && git pull; else rm -rf ${appDir} && git clone${branchFlag} ${cloneUrl} ${appDir}; fi`),
    hostKey,
  );
  if (cloneResult.exitCode !== 0) {
    const stderr = cloneResult.stderr;
    log("build", `Clone failed (exit=${cloneResult.exitCode}): ${stderr.slice(0, 800)}`);
    const notFound = stderr.match(/Repository not found/i);
    const isAuthError = stderr.match(/could not read Username|Authentication failed|403/i);
    if (notFound && gitToken) {
      throw new Error(`Git clone failed: repository not found. Check that the repo URL is correct and your GitHub token has access to it.`);
    }
    if ((isAuthError || notFound) && !gitToken) {
      throw new Error(`Git clone failed: repository requires authentication. Link your GitHub account in Account settings.`);
    }
    if (isAuthError && gitToken) {
      throw new Error(`Git clone failed: authentication rejected. Check that your GitHub token is valid and has the "repo" scope.`);
    }
    throw new Error(describeFailure("Git clone failed", cloneResult));
  }

  // Strip token from git remote
  if (gitToken && cloneUrl !== gitRepo) {
    await sshExec(ip, asUser(`cd ${appDir} && git remote set-url origin ${gitRepo}`), hostKey);
  }
  log("build", `Clone done, stdout: ${cloneResult.stdout.trim().slice(0, 200)}`);
}

export async function cloneAndBuild(
  ip: string,
  opts: {
    name: string;
    gitRepo: string;
    port: number; // container port
    hostPort: number; // host-side port for docker binding
    envVars: Record<string, string>;
    volumeMount?: string; // e.g. "/mnt/data:/data" — host:container
    extraVolumes?: string[]; // additional -v mounts, e.g. ["/host:/container"]
    dockerfilePath?: string; // explicit path to Dockerfile in repo
    dockerContext?: string; // build context path relative to repo root, defaults to "."
    gitToken?: string; // GitHub PAT for private repos
    gitBranch?: string; // Branch to clone, defaults to repo default
    /** Host-side bind address for the published port. Defaults to 127.0.0.1
     *  so containers aren't exposed on the public interface. Pass the
     *  server's `private_ipv4` when the app is reached by the ingress proxy
     *  over the shared private network. */
    bindAddr?: string;
    /** Override for the docker container name. Defaults to `opts.name`.
     *  Needed when redeploying a replica whose container is named
     *  `${app}-r${n}` (from scaleUp/migrate) rather than bare `${app}`. */
    containerName?: string;
    /** When true, assume the repo is already cloned (the engine `clone_repo`
     *  step ran first). Skips the in-helper clone. */
    skipClone?: boolean;
    /** Per-container memory ceiling in MB. Omit / 0 → platform default. */
    memoryMb?: number;
    /** Per-container CPU ceiling in cores. Omit / 0 → platform default. */
    cpus?: number;
    /** Pinned SSH host key of the target server, threaded to every remote call. */
    hostKey?: string;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const hostKey = opts.hostKey;

  if (!opts.skipClone) {
    await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit, opts.gitBranch, hostKey);
  }

  // Find Dockerfile
  let dockerfilePath = opts.dockerfilePath?.replace(/^\/+/, "");
  if (dockerfilePath) {
    emit(`Using specified Dockerfile: ${dockerfilePath}`);
    const checkResult = await sshExec(ip, asUser(`test -f ${appDir}/${dockerfilePath} && echo ok`), hostKey);
    if (checkResult.stdout.trim() !== "ok") {
      throw new Error(`Dockerfile not found at "${dockerfilePath}" in the repository. The path should be relative to the repo root, e.g. "Dockerfile" or "docker/Dockerfile".`);
    }
    log("build", `Using specified Dockerfile: ${dockerfilePath}`);
  } else {
    emit("Searching for Dockerfile...");
    dockerfilePath = await findDockerfile(ip, appDir, hostKey);
    if (!dockerfilePath) {
      throw new Error("No Dockerfile found in repository");
    }
    log("build", `Found Dockerfile: ${dockerfilePath}`);
    emit(`Found Dockerfile at: ${dockerfilePath}`);
  }

  // Authenticate with ghcr.io if a GitHub token is available (needed for
  // private base images in FROM directives). Credentials live in a per-deploy
  // DOCKER_CONFIG dir and are wiped immediately after the build.
  let ghcrAuth: GhcrAuth | null = null;
  if (opts.gitToken) {
    ghcrAuth = await dockerLoginGhcr(ip, opts.gitToken, hostKey);
  }

  // Build image first (before stopping old container — build-before-destroy)
  emit("Building Docker image...");
  const dockerBuildStart = Date.now();
  try {
    await buildAppImage(ip, {
      appDir,
      imageTag: `${opts.name}:latest`,
      dockerfilePath,
      dockerContext: opts.dockerContext,
      envPrefix: ghcrAuth?.envPrefix,
    }, hostKey);
  } finally {
    // Wipe the ephemeral ghcr creds whether or not the build succeeded.
    if (ghcrAuth) await ghcrAuth.cleanup();
  }
  log("build", `Docker build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully");

  // Build succeeded — now safe to stop old container and swap.
  const containerName = opts.containerName || opts.name;
  emit("Starting container...");
  // Ensure ocd-net exists so apps can reach infrastructure services by container name
  await ensureOcdNetwork(ip, hostKey);
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const { containerId } = await startAppReplica(ip, {
    containerName,
    image: `${opts.name}:latest`,
    appName: opts.name,
    bindAddr,
    hostPort: opts.hostPort,
    containerPort: opts.port,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb || undefined,
    cpus: opts.cpus || undefined,
    envVars: opts.envVars,
  }, hostKey);
  log("build", `Container started: ${containerId.slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name, hostKey);

  return { containerId, dockerfilePath, imageTag: `${opts.name}:latest` };
}
