import { sshExec, describeFailure } from "./ssh.ts";
import { asUser, log, buildDockerRunArgs, withImageGcLease } from "./container-common.ts";
import * as db from "../../shared/db.ts";
import { REVISION_LABELS } from "../revision.ts";

type SshExecutor = typeof sshExec;

async function writeEnvDeployFileWithSsh(
  exec: SshExecutor,
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
  await exec(
    ip,
    `mkdir -p ${appDir} && chown deploy:deploy ${baseDir} ${appDir} && echo '${content}' > ${envFilePath} && chown deploy:deploy ${envFilePath} && chmod 600 ${envFilePath}`,
    hostKey,
  );
  return envFilePath;
}

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
  return writeEnvDeployFileWithSsh(sshExec, ip, appName, envVars, hostKey, baseDir);
}

async function ensureVolumeOwnershipWithSsh(
  exec: SshExecutor,
  ip: string,
  image: string,
  hostMountPath: string,
  hostKey?: string,
): Promise<void> {
  const inspect = await exec(ip, asUser(`docker inspect --format '{{.Config.User}}' ${image}`), hostKey);
  const userSpec = inspect.stdout.trim();
  if (!userSpec || userSpec === "0" || userSpec === "root" || userSpec === "0:0") return;

  let uid = "";
  let gid = "";
  const idProbe = await exec(ip, asUser(`docker run --rm --entrypoint '' ${image} id 2>/dev/null`), hostKey);
  const m = idProbe.stdout.match(/uid=(\d+)\D.*?gid=(\d+)/);
  if (m) {
    uid = m[1];
    gid = m[2];
  } else {
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

  const chown = await exec(ip, `chown ${uid}:${gid} ${hostMountPath}`, hostKey);
  if (chown.exitCode !== 0) {
    throw new Error(
      `chown ${uid}:${gid} ${hostMountPath} failed (exit ${chown.exitCode}): ${chown.stderr.trim() || chown.stdout.trim()}`,
    );
  }
  log("run", `volume root ${hostMountPath} chowned to ${uid}:${gid} for ${image}`);
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
  return ensureVolumeOwnershipWithSsh(sshExec, ip, image, hostMountPath, hostKey);
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
  /** Override service aliases. Omit to inject every current
   * `<service>.svc.ocd.internal` mapping from desired state. */
  extraHosts?: Array<{ hostname: string; address: string }>;
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
  configRevision?: number;
  envHash?: string;
};

/** Resolve the current single-instance service names to their private fleet
 * addresses. Exported so reload/deploy parity can be regression-tested without
 * reaching a real Docker host. */
export function currentServiceAliases(): Array<{ hostname: string; address: string }> {
  const aliases: Array<{ hostname: string; address: string }> = [];
  try {
    for (const service of db.getServices()) {
      const instance = db.getServiceInstances(service.id)[0];
      const server = instance ? db.getServer(instance.server_id) : null;
      if (server?.private_ipv4) {
        aliases.push({
          hostname: `${service.name}.svc.ocd.internal`,
          address: server.private_ipv4,
        });
      }
    }
  } catch {
    // Early bootstrap and isolated unit tests may not have an initialized DB.
  }
  return aliases;
}

export function currentAppAliases(): Array<{ hostname: string; address: string }> {
  try {
    return db.getApps()
      .filter((app) => Boolean(app.virtual_ip))
      .map((app) => ({
        hostname: `${app.name}.ocd.internal`,
        address: app.virtual_ip,
      }));
  } catch {
    return [];
  }
}

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
  return startAppReplicaWithSsh(sshExec, ip, opts, hostKey);
}

/** Dependency-injected variant used by command-construction tests so their
 * SSH capture cannot be replaced by another test file's process-global mock. */
export async function startAppReplicaWithSsh(
  exec: SshExecutor,
  ip: string,
  opts: StartAppReplicaOpts,
  hostKey?: string,
): Promise<{ containerId: string }> {
  let envFilePath = opts.envFilePath;
  if (opts.envVars !== undefined) {
    envFilePath = await writeEnvDeployFileWithSsh(exec, ip, opts.appName, opts.envVars, hostKey, opts.baseDir);
  }

  const imageInspect = await exec(
    ip,
    asUser(`docker image inspect --format '{{.Id}}' ${opts.image}`),
    hostKey,
  );
  if (imageInspect.exitCode !== 0 || !imageInspect.stdout.trim()) {
    throw new Error(describeFailure(`Unable to resolve immutable image ${opts.image}`, imageInspect));
  }
  const imageId = imageInspect.stdout.trim();
  const labels = {
    [REVISION_LABELS.app]: opts.appName,
    [REVISION_LABELS.configRevision]: String(opts.configRevision ?? 0),
    [REVISION_LABELS.envHash]: opts.envHash ?? "",
    [REVISION_LABELS.imageRef]: opts.image,
    [REVISION_LABELS.imageId]: imageId,
    [REVISION_LABELS.bindAddress]: opts.bindAddr,
    [REVISION_LABELS.hostPort]: String(opts.hostPort),
  };

  if (opts.removeExisting !== false) {
    // Crash-resume adoption: keep an already-running exact revision. A stale
    // or mismatched namesake is removed so retry is deterministic.
    const existing = await exec(
      ip,
      asUser(`docker inspect --format '{{json .Config.Labels}}|{{.State.Running}}|{{.Id}}' ${opts.containerName} 2>/dev/null || true`),
      hostKey,
    );
    const [rawLabels, running, existingId] = existing.stdout.trim().split("|");
    let same = false;
    try {
      const current = JSON.parse(rawLabels || "{}");
      same = running === "true" && Object.entries(labels).every(([key, value]) => current?.[key] === value);
    } catch { /* remove malformed/legacy container */ }
    if (same) {
      log("run", `Adopted existing attested container ${opts.containerName}`);
      return { containerId: existingId || opts.containerName };
    }
    await exec(ip, asUser(`docker rm -f ${opts.containerName} 2>/dev/null || true`), hostKey);
  }

  // A fresh block volume is root-owned; make its root writable by the image's
  // runtime user before we start the hardened (cap-dropped) container, which
  // otherwise can't chown it itself. No-op for root images / already-correct mounts.
  if (opts.volumeMount) {
    await ensureVolumeOwnershipWithSsh(exec, ip, opts.image, opts.volumeMount.split(":")[0], hostKey);
  }

  // `/etc/hosts` on the fleet host is not inherited by Docker containers.
  // Resolve the managed-service aliases on every create/recreate path here,
  // rather than relying on each deploy/rollback/reload caller to remember.
  // This keeps environment-only reloads equivalent to initial deploys.
  let extraHosts = opts.extraHosts;
  if (extraHosts === undefined) {
    extraHosts = [...currentAppAliases(), ...currentServiceAliases()];
  }

  const cmd = buildDockerRunArgs({
    name: opts.containerName,
    image: opts.image,
    appName: opts.appName,
    network: opts.network,
    extraHosts,
    publish: { bindAddr: opts.bindAddr, hostPort: opts.hostPort, containerPort: opts.containerPort },
    extraPublish: opts.extraPublish,
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
    labels,
  });
  // Keep GC out while Docker resolves the image tag and creates the container.
  // The build path takes the same shared lease, while every prune takes the
  // exclusive side, closing both ends of the build-before-run race.
  const result = await exec(ip, asUser(withImageGcLease(cmd)), hostKey);
  if (result.exitCode !== 0) {
    log("run", `Docker run stderr: ${result.stderr}`);
    throw new Error(describeFailure("Failed to start container", result));
  }
  return { containerId: result.stdout.trim() };
}
