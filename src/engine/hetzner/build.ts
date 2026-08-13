import { sshExec, sshExecStreaming, describeFailure } from "./ssh.ts";
import { asUser, log, OCD_IMAGE_LABEL, withImageGcLease } from "./container-common.ts";
import { dockerLoginGhcr, dockerLoginRegistry, type GhcrAuth } from "./registry.ts";
import { startAppReplica } from "./docker-run.ts";
import { ensureOcdNetwork } from "./lifecycle.ts";
import { pruneAfterBuild } from "./prune.ts";
import { preflightBuildDiskSpace } from "./disk-space.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";

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
    /** Incremental, already-sanitized operation log sink. */
    onOutput?: (line: string) => void;
    /** Registry-backed BuildKit cache shared between build hosts. */
    cacheRef?: string;
    /** Keep external admission/accounting leases alive during long builds. */
    onHeartbeat?: () => void;
  },
  hostKey?: string,
): Promise<void> {
  const dockerContext = opts.dockerContext || ".";
  const cacheArgs = opts.cacheRef
    ? `--cache-from=type=registry,ref=${opts.cacheRef} --cache-to=type=registry,ref=${opts.cacheRef},mode=max`
    : "";
  const builder = opts.cacheRef ? "docker buildx build --load" : "docker build";
  const rawBuildCmd = `cd ${opts.appDir} && ${opts.envPrefix ?? ""}${builder} --progress=plain --label ${OCD_IMAGE_LABEL} ${cacheArgs} -t ${opts.imageTag} -f ${opts.dockerfilePath} ${dockerContext}`;
  // Builds take a shared lease; prune paths take the exclusive side of the
  // same host lock. Multiple builds remain concurrent, while GC can never
  // remove image/cache state out from under an active build.
  const buildCmd = withImageGcLease(rawBuildCmd);
  log("build", `Docker build command: ${buildCmd}`);
  const result = await sshExecStreaming(ip, asUser(buildCmd), {
    hostKey,
    onLine: (line) => {
      if (line.trim()) opts.onOutput?.(line);
    },
    onHeartbeat: (elapsedMs, outputLines) => {
      opts.onHeartbeat?.();
      opts.onOutput?.(
        `Docker build still running (${Math.floor(elapsedMs / 1000)}s, ${outputLines} output lines)…`,
      );
    },
  });
  if (result.exitCode !== 0) {
    log("build", `Docker build stderr: ${result.stderr.slice(0, 500)}`);
    throw new Error(describeFailure("Docker build failed", result));
  }
  // A zero exit from `docker build` is not proof the image is loadable locally:
  // a concurrent prune can sweep the just-built (still-unreferenced) image, or a
  // buildx container-driver builder can leave it in the build cache without
  // `--load`. Either way `-t name:latest` "succeeds" yet `docker run` then fails
  // "Unable to find image". Callers swap on the strength of this build
  // (build-before-destroy), so verify the tag actually resolves before we return
  // — failing here keeps the running container untouched instead of tearing it
  // down for an image that isn't there. (The prune race itself is fixed in
  // prune.ts via an age guard; this is the belt-and-suspenders check.)
  const present = await sshExec(
    ip,
    asUser(`docker image inspect ${opts.imageTag} >/dev/null 2>&1 && echo ok || echo missing`),
    hostKey,
  );
  if (present.stdout.trim() !== "ok") {
    throw new Error(
      `Docker build reported success but image ${opts.imageTag} is not present in the local image store ` +
        `(swept by a concurrent prune, or built into a buildx cache without \`--load\`). ` +
        `Refusing to swap the running container.`,
    );
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
  gitSha?: string,
): Promise<string> {
  const appDir = `/home/deploy/apps/${appName}`;

  let cloneUrl = gitRepo;
  if (gitToken && cloneUrl.match(/^https:\/\/github\.com\//)) {
    cloneUrl = cloneUrl.replace(
      /^https:\/\/github\.com\//,
      `https://x-access-token:${gitToken}@github.com/`
    );
  }

  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const branchFlag = gitBranch ? ` --branch ${shellQuote(gitBranch)}` : "";
  emit?.("Creating fresh immutable checkout...");
  log("build", `Cloning ${gitRepo} into a fresh ${appDir} worktree (token: ${gitToken ? "yes" : "no"}, branch: ${gitBranch || "default"}, commit: ${gitSha || "remote HEAD"})`);
  // Ensure the app dir (if it exists) is owned by deploy so the subsequent
  // rm -rf/git clone/pull works even if a prior root-run step (e.g. scaleUp
  // writing .env.deploy) left root-owned files behind.
  await sshExec(ip, `mkdir -p /home/deploy/apps && chown deploy:deploy /home/deploy/apps && mkdir -p ${appDir} && chown -R deploy:deploy ${appDir}`, hostKey);
  const gitEnv = gitToken ? "export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true; " : "";
  const explicitTarget = gitSha
    ? shellQuote(gitSha)
    : gitBranch
      ? shellQuote(`origin/${gitBranch}`)
      : '"$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo origin/HEAD)"';
  const cloneResult = await sshExec(
    ip,
    asUser(
      `${gitEnv}rm -rf ${shellQuote(appDir)} && ` +
      `git clone --no-checkout${branchFlag} ${shellQuote(cloneUrl)} ${shellQuote(appDir)} && ` +
      `cd ${shellQuote(appDir)} && git fetch --prune origin${gitSha ? ` ${shellQuote(gitSha)}` : ""} && ` +
      `target=${explicitTarget} && git checkout --detach "$target" && ` +
      `git reset --hard "$target" && git clean -ffd && git rev-parse HEAD`,
    ),
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
  const revision = cloneResult.stdout.trim().split(/\s+/).at(-1) || "";
  if (!/^[0-9a-f]{40,64}$/i.test(revision)) {
    throw new Error(`Git checkout completed but did not report an immutable commit`);
  }
  emit?.(`Checked out ${revision.slice(0, 12)} (detached, clean worktree)`);
  log("build", `Clone done at immutable commit ${revision}`);
  return revision;
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
    gitSha?: string; // Exact immutable commit to check out
    /** Host-side bind address for the published port. Defaults to 127.0.0.1
     *  so containers aren't exposed on the public interface. Pass the
     *  server's `private_ipv4` when the app is reached by the ingress proxy
     *  over the shared private network. */
    bindAddr?: string;
    /** Extra, already-formatted `-p ...` publish flags beyond the primary
     *  hostPort (e.g. the panel's waker port from wakerPublishFlags). */
    extraPublish?: string[];
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
    /** Registry-backed BuildKit cache shared between build hosts. */
    buildCacheRef?: string;
    registryUsername?: string;
    registryPassword?: string;
    /** Reserve space for the explicitly-enabled emergency archive path when
     * this build will immediately fan out to another host. */
    reserveArchiveSpace?: boolean;
    configRevision?: number;
    envHash?: string;
  },
  onLog?: (line: string) => void
) {
  const appDir = `/home/deploy/apps/${opts.name}`;
  const emit = (msg: string) => onLog?.(msg);
  const buildStart = Date.now();
  const hostKey = opts.hostKey;

  if (!opts.skipClone) {
    await cloneRepo(ip, opts.name, opts.gitRepo, opts.gitToken, emit, opts.gitBranch, hostKey, opts.gitSha);
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
  const resolvedContext = (opts.dockerContext || ".").replace(/^\/+/, "");
  const pathPreflight = await sshExec(
    ip,
    asUser(
      `test -d ${appDir}/${resolvedContext} && test -f ${appDir}/${dockerfilePath} && ` +
        `printf 'repo=%s\\ncontext=%s\\ndockerfile=%s\\n' ${appDir} ${appDir}/${resolvedContext} ${appDir}/${dockerfilePath}`,
    ),
    hostKey,
  );
  if (pathPreflight.exitCode !== 0) {
    throw new Error(
      `Build path preflight failed: repository root=${appDir}, context=${appDir}/${resolvedContext}, ` +
        `Dockerfile=${appDir}/${dockerfilePath}`,
    );
  }
  emit(
    `Resolved build paths: repository root=${appDir}; context=${appDir}/${resolvedContext}; ` +
      `Dockerfile=${appDir}/${dockerfilePath}`,
  );

  // Fail before an expensive build if the source host cannot safely hold the
  // new expanded image and (when no registry is configured) its fallback
  // transfer archive. This also performs bounded OCD-only GC first.
  const diskReservation = await preflightBuildDiskSpace({
    ip,
    appName: opts.name,
    contextPath: `${appDir}/${resolvedContext}`,
    registryBacked: !!opts.buildCacheRef || !opts.reserveArchiveSpace,
    hostKey,
    onProgress: emit,
  });

  try {
  // Authenticate with ghcr.io if a GitHub token is available (needed for
  // private base images in FROM directives). Credentials live in a per-deploy
  // DOCKER_CONFIG dir and are wiped immediately after the build.
  let ghcrAuth: GhcrAuth | null = null;
  if (opts.buildCacheRef && opts.registryUsername && opts.registryPassword) {
    ghcrAuth = await dockerLoginRegistry(
      ip,
      opts.buildCacheRef,
      opts.registryUsername,
      opts.registryPassword,
      hostKey,
    );
  } else if (opts.gitToken) {
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
      onOutput: emit,
      cacheRef: opts.buildCacheRef,
      onHeartbeat: () => { void diskReservation.refresh(); },
    }, hostKey);
  } finally {
    // Wipe the ephemeral ghcr creds whether or not the build succeeded.
    if (ghcrAuth) await ghcrAuth.cleanup();
  }
  log("build", `Docker build completed in ${((Date.now() - dockerBuildStart) / 1000).toFixed(1)}s`);
  emit("Image built successfully");
  const builtImage = await sshExec(
    ip,
    asUser(`docker image inspect --format='{{.Id}} {{.Size}}' ${opts.name}:latest`),
    hostKey,
  );
  const [imageDigest = "", imageSizeRaw = ""] = builtImage.stdout.trim().split(/\s+/);
  const imageBytes = Number(imageSizeRaw) || 0;
  if (!imageDigest || imageBytes <= 0) {
    throw new Error(describeFailure("Built image size inspection failed", builtImage));
  }
  // The candidate now occupies real disk and is visible to df. Retain only
  // the future archive claim (if this build fans out without a registry),
  // replacing the conservative input-derived estimate with its actual size.
  await diskReservation.replace(opts.reserveArchiveSpace && !opts.buildCacheRef ? imageBytes : 0);
  emit(`Built image occupies ${(imageBytes / 1024 / 1024).toFixed(1)} MiB expanded`);

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
    extraPublish: opts.extraPublish,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb || undefined,
    cpus: opts.cpus || undefined,
    envVars: opts.envVars,
    configRevision: opts.configRevision,
    envHash: opts.envHash,
  }, hostKey);
  log("build", `Container started: ${containerId.slice(0, 12)}... Total build time: ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Fire-and-forget cleanup of dangling images and git repo
  pruneAfterBuild(ip, opts.name, hostKey);

  return { containerId, dockerfilePath, imageTag: `${opts.name}:latest`, imageDigest, imageBytes };
  } finally {
    await diskReservation.release();
  }
}

/**
 * Pull and run an immutable prebuilt OCI artifact. The digest is the deployment
 * identity; tags are intentionally rejected by request/manifest validation.
 * A local app:latest alias keeps scale/migration paths compatible while the
 * returned imageTag/imageDigest retain the immutable registry identity.
 */
export async function pullImmutableImageAndRun(
  ip: string,
  opts: {
    name: string;
    imageRef: string;
    port: number;
    hostPort: number;
    envVars: Record<string, string>;
    containerName?: string;
    bindAddr?: string;
    volumeMount?: string;
    extraVolumes?: string[];
    memoryMb?: number;
    cpus?: number;
    gitToken?: string;
    hostKey?: string;
    configRevision?: number;
    envHash?: string;
  },
  onLog?: (line: string) => void,
): Promise<{ containerId: string; imageTag: string; imageDigest: string; imageBytes: number }> {
  await pullImmutableImage(ip, {
    name: opts.name,
    imageRef: opts.imageRef,
    gitToken: opts.gitToken,
    hostKey: opts.hostKey,
  }, onLog);
  const hostKey = opts.hostKey;

  await ensureOcdNetwork(ip, hostKey);
  const { containerId } = await startAppReplica(ip, {
    containerName: opts.containerName || opts.name,
    image: opts.imageRef,
    appName: opts.name,
    bindAddr: opts.bindAddr || "127.0.0.1",
    hostPort: opts.hostPort,
    containerPort: opts.port,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
    envVars: opts.envVars,
    configRevision: opts.configRevision,
    envHash: opts.envHash,
  }, hostKey);
  const inspected = await sshExec(
    ip,
    asUser(`docker image inspect --format '{{.Size}}' ${JSON.stringify(opts.imageRef)}`),
    hostKey,
  );
  const imageBytes = Math.max(0, Number(inspected.stdout.trim()) || 0);
  return { containerId, imageTag: opts.imageRef, imageDigest: opts.imageRef, imageBytes };
}

export async function pullImmutableImage(
  ip: string,
  opts: { name: string; imageRef: string; gitToken?: string; hostKey?: string },
  onLog?: (line: string) => void,
): Promise<void> {
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(opts.imageRef)) {
    throw new Error("Immutable image reference must end in @sha256:<64 hex digest>");
  }
  const hostKey = opts.hostKey;
  let auth: GhcrAuth | null = null;
  const registryCredentials = await resolveRegistryCredentialsForImage(opts.imageRef);
  if (registryCredentials.username && registryCredentials.password) {
    auth = await dockerLoginRegistry(
      ip,
      opts.imageRef,
      registryCredentials.username,
      registryCredentials.password,
      hostKey,
    );
  } else if (opts.gitToken && opts.imageRef.toLowerCase().startsWith("ghcr.io/")) {
    auth = await dockerLoginGhcr(ip, opts.gitToken, hostKey);
  }
  try {
    onLog?.(`Pulling immutable image ${opts.imageRef}`);
    const pull = await sshExecStreaming(
      ip,
      asUser(`${auth?.envPrefix ?? ""}docker pull ${opts.imageRef}`),
      { hostKey, onLine: (line) => line.trim() && onLog?.(line) },
    );
    if (pull.exitCode !== 0) throw new Error(describeFailure("Docker image pull failed", pull));
    await sshExec(ip, asUser(`docker tag ${opts.imageRef} ${opts.name}:latest`), hostKey);
  } finally {
    if (auth) await auth.cleanup();
  }
}
