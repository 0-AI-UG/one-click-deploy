import { sshExec, describeFailure } from "./ssh.ts";
import { asUser, log, buildDockerRunArgs, withImageGcLease } from "./container-common.ts";

/**
 * Write `<baseDir>/<appName>/.env.deploy` from resolved env vars — single-quote
 * escaping the values (so container env can contain anything), creating the app
 * dir first (fresh scale-up targets have none), and locking the file down
 * (chown deploy, chmod 600). Returns the path, or undefined when there are no
 * vars (caller then runs with no --env-file).
 */
export async function writeEnvDeployFile(
  ip: string,
  appName: string,
  envVars: Record<string, string>,
  hostKey?: string,
  baseDir = "/home/deploy/apps",
): Promise<string | undefined> {
  const entries = Object.entries(envVars);
  if (entries.length === 0) return undefined;
  const appDir = `${baseDir}/${appName}`;
  const envFilePath = `${appDir}/.env.deploy`;
  const content = entries.map(([k, v]) => `${k}=${v}`).join("\n").replace(/'/g, "'\\''");
  await sshExec(
    ip,
    `mkdir -p ${appDir} && chown deploy:deploy ${baseDir} ${appDir} && echo '${content}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
    hostKey,
  );
  return envFilePath;
}

/**
 * Make a freshly-provisioned volume writable by the container's runtime user.
 *
 * Fresh Hetzner block volumes are root:root, and OCD runs every container with
 * `--cap-drop=ALL --security-opt=no-new-privileges`, so a non-root image (e.g.
 * postgres shipping `USER postgres`) can't chown its own data dir at runtime
 * (CAP_CHOWN is gone) and therefore can't cold-start on a fresh volume — initdb
 * fails with "Permission denied" and the container exits. We fix it host-side,
 * as root, *before* the container starts: chown the volume's mount root to the
 * uid[:gid] the image actually runs as.
 *
 * Best-effort and idempotent:
 *  - root-owned images (`Config.User` unset / "0" / "root") need nothing → skip.
 *  - only the mount root is chowned (non-recursive), so adopting a volume that
 *    already holds user-owned data is a harmless no-op and nested ownership is
 *    never clobbered.
 *  - if the runtime uid can't be resolved (e.g. no `id` in a distroless image),
 *    we log and leave the mount as-is — no worse than before this fix.
 *
 * A genuine chown failure (non-zero exit) is surfaced: that's an unexpected
 * host error, and letting it through only to fail later as an opaque
 * "did not become healthy" would hide the real cause.
 */
export async function ensureVolumeOwnership(
  ip: string,
  image: string,
  hostMountPath: string,
  hostKey?: string,
): Promise<void> {
  // Which user will the container run as? Empty / 0 / root → nothing to do.
  const inspect = await sshExec(ip, asUser(`docker inspect --format '{{.Config.User}}' ${image}`), hostKey);
  const userSpec = inspect.stdout.trim();
  if (!userSpec || userSpec === "0" || userSpec === "root" || userSpec === "0:0") return;

  // Resolve to a numeric uid[:gid]. `id` run under the image's default USER
  // reports the real runtime ids whether Config.User is a name ("postgres") or
  // a number ("70") — override the entrypoint so we run `id`, not the app.
  let uid = "";
  let gid = "";
  const idProbe = await sshExec(ip, asUser(`docker run --rm --entrypoint '' ${image} id 2>/dev/null`), hostKey);
  const m = idProbe.stdout.match(/uid=(\d+)\D.*?gid=(\d+)/);
  if (m) {
    uid = m[1];
    gid = m[2];
  } else {
    // Fall back to a numeric Config.User ("70" or "70:70"); a named user we
    // couldn't resolve is left alone rather than guessed at.
    const [u, g] = userSpec.split(":");
    if (/^\d+$/.test(u)) {
      uid = u;
      gid = /^\d+$/.test(g ?? "") ? g : u;
    }
  }
  if (!uid) {
    log("run", `could not resolve runtime uid for ${image}; leaving ${hostMountPath} ownership unchanged`);
    return;
  }

  const chown = await sshExec(ip, `chown ${uid}:${gid} ${hostMountPath}`, hostKey);
  if (chown.exitCode !== 0) {
    throw new Error(
      `chown ${uid}:${gid} ${hostMountPath} failed (exit ${chown.exitCode}): ${chown.stderr.trim() || chown.stdout.trim()}`,
    );
  }
  log("run", `volume root ${hostMountPath} chowned to ${uid}:${gid} for ${image}`);
}

export type StartAppReplicaOpts = {
  /** Container name (--name). */
  containerName: string;
  /** Image ref to run (e.g. "app:latest", "app:rollback", a prior image id). */
  image: string;
  appName: string;
  bindAddr: string;
  hostPort: number;
  containerPort: number;
  /** Docker network. Defaults to "ocd-net"; pass null for the default bridge
   *  (replicas historically don't join ocd-net). */
  network?: string | null;
  volumeMount?: string;
  extraVolumes?: string[];
  /** Extra, already-formatted `-p ...` publish flags beyond the primary port
   *  (e.g. the panel's waker port). Passed through to buildDockerRunArgs. */
  extraPublish?: string[];
  memoryMb?: number;
  /** Per-container CPU ceiling in cores. Omit / 0 → platform default. */
  cpus?: number;
  /** When provided, (re)write .env.deploy from these vars and use it. Mutually
   *  exclusive with envFilePath. Empty object → run with no env file. */
  envVars?: Record<string, string>;
  /** Use a pre-existing env file path verbatim (compensation/snapshot paths). */
  envFilePath?: string;
  /** App dir base for the env file (default /home/deploy/apps). */
  baseDir?: string;
  /** `docker rm -f` any same-named container first. Default true; wake's slow
   *  path passes false (the container provably does not exist). */
  removeExisting?: boolean;
};

/**
 * The one place that starts a hardened app-replica container: optional
 * `.env.deploy` (re)write → `docker rm -f` the stale container → hardened
 * `docker run` (always via buildDockerRunArgs, so cap-drop / no-new-privileges /
 * mem-cpu-pids ceilings / volume allowlisting can never be forgotten). Throws
 * describeFailure() on a non-zero run. Returns the new container id.
 */
export async function startAppReplica(
  ip: string,
  opts: StartAppReplicaOpts,
  hostKey?: string,
): Promise<{ containerId: string }> {
  let envFilePath = opts.envFilePath;
  if (opts.envVars !== undefined) {
    envFilePath = await writeEnvDeployFile(ip, opts.appName, opts.envVars, hostKey, opts.baseDir);
  }

  if (opts.removeExisting !== false) {
    await sshExec(ip, asUser(`docker rm -f ${opts.containerName} 2>/dev/null || true`), hostKey);
  }

  // A fresh block volume is root-owned; make its root writable by the image's
  // runtime user before we start the hardened (cap-dropped) container, which
  // otherwise can't chown it itself. No-op for root images / already-correct mounts.
  if (opts.volumeMount) {
    await ensureVolumeOwnership(ip, opts.image, opts.volumeMount.split(":")[0], hostKey);
  }

  const cmd = buildDockerRunArgs({
    name: opts.containerName,
    image: opts.image,
    appName: opts.appName,
    network: opts.network,
    publish: { bindAddr: opts.bindAddr, hostPort: opts.hostPort, containerPort: opts.containerPort },
    extraPublish: opts.extraPublish,
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
  });
  // Keep GC out while Docker resolves the image tag and creates the container.
  // The build path takes the same shared lease, while every prune takes the
  // exclusive side, closing both ends of the build-before-run race.
  const result = await sshExec(ip, asUser(withImageGcLease(cmd)), hostKey);
  if (result.exitCode !== 0) {
    log("run", `Docker run stderr: ${result.stderr}`);
    throw new Error(describeFailure("Failed to start container", result));
  }
  return { containerId: result.stdout.trim() };
}
