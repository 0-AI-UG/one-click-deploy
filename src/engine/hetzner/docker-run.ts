import { sshExec, describeFailure } from "./ssh.ts";
import { asUser, log, buildDockerRunArgs } from "./container-common.ts";

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

  const cmd = buildDockerRunArgs({
    name: opts.containerName,
    image: opts.image,
    appName: opts.appName,
    network: opts.network,
    publish: { bindAddr: opts.bindAddr, hostPort: opts.hostPort, containerPort: opts.containerPort },
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
  });
  const result = await sshExec(ip, asUser(cmd), hostKey);
  if (result.exitCode !== 0) {
    log("run", `Docker run stderr: ${result.stderr}`);
    throw new Error(describeFailure("Failed to start container", result));
  }
  return { containerId: result.stdout.trim() };
}
