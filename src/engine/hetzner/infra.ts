import { sshExec } from "./ssh.ts";
import { asUser, log, buildDockerRunArgs } from "./container-common.ts";
import { dockerLoginRegistry, type RegistryAuth } from "./registry.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";
import { writeEnvDeployFile, ensureVolumeOwnership } from "./docker-run.ts";
import { ensureOcdNetwork } from "./lifecycle.ts";

// --- Infrastructure Service Containers ---

export async function pullAndRunService(
  ip: string,
  opts: {
    name: string;
    image: string;           // e.g. "postgres:17-alpine"
    port: number;            // container port
    hostPort: number;        // host-side port
    envVars: Record<string, string>;
    volumeMount?: string;    // e.g. "/mnt/ocd-my-postgres-data:/var/lib/postgresql/data"
    cmd?: string[];          // custom entrypoint/cmd args
    bindAddress?: string;    // "127.0.0.1" (default) or "0.0.0.0"
    extraVolumes?: string[]; // additional -v mounts (e.g. config files)
    /** Override memory ceiling (MB). Infra services may need more than the app default. */
    memoryMb?: number;
    /** Override CPU ceiling. */
    cpus?: number;
    /** Capabilities to add back after --cap-drop=ALL (e.g. ["CHOWN","SETUID","SETGID"] for postgres). */
    extraCaps?: string[];
  },
  hostKey?: string
): Promise<{ containerId: string }> {
  const bindAddr = opts.bindAddress || "127.0.0.1";

  // Configured OCI credentials live in a per-pull DOCKER_CONFIG directory and
  // are sent only when the image registry matches the configured repository.
  let registryAuth: RegistryAuth | null = null;
  const credentials = await resolveRegistryCredentialsForImage(opts.image);
  if (credentials.username && credentials.password) {
    registryAuth = await dockerLoginRegistry(
      ip,
      opts.image,
      credentials.username,
      credentials.password,
      hostKey,
    );
  }

  log("service", `Pulling image ${opts.image}...`);
  let pullResult: Awaited<ReturnType<typeof sshExec>>;
  try {
    pullResult = await sshExec(ip, asUser(`${registryAuth?.envPrefix ?? ""}docker pull ${opts.image}`), hostKey);
  } finally {
    if (registryAuth) await registryAuth.cleanup();
  }
  if (pullResult.exitCode !== 0) {
    throw new Error(`Failed to pull image ${opts.image}: ${pullResult.stderr}`);
  }

  // Ensure ocd-net exists
  await ensureOcdNetwork(ip, hostKey);

  // Write env file
  const envFilePath = await writeEnvDeployFile(ip, opts.name, opts.envVars, hostKey, "/home/deploy/services");

  // Remove existing container if any
  await sshExec(ip, asUser(`docker rm -f ${opts.name} 2>/dev/null || true`), hostKey);

  // A fresh block volume is root-owned. Fixed non-root images (USER baked in)
  // need the mount root chowned to their uid before they can write; root ->
  // gosu-drop images (postgres/mysql/...) instead get CHOWN/SETUID/SETGID back
  // via extraCaps and do the chown themselves (this call no-ops for them, since
  // their Config.User is root). See ensureVolumeOwnership for the full rationale.
  if (opts.volumeMount) {
    await ensureVolumeOwnership(ip, opts.image, opts.volumeMount.split(":")[0], hostKey);
  }

  // Build run command
  const cmdStr = opts.cmd ? opts.cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(" ") : undefined;

  const runCmd = buildDockerRunArgs({
    name: opts.name,
    image: opts.image,
    appName: opts.name,
    publish: { bindAddr, hostPort: opts.hostPort, containerPort: opts.port },
    envFilePath,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
    extraCaps: opts.extraCaps,
    cmd: cmdStr,
  });

  log("service", `Docker run: ${runCmd}`);
  const result = await sshExec(ip, asUser(runCmd), hostKey);
  if (result.exitCode !== 0) {
    log("service", `Docker run stderr: ${result.stderr}`);
    throw new Error(`Failed to start service container ${opts.name}: ${result.stderr}`);
  }

  const containerId = result.stdout.trim().slice(0, 12);
  log("service", `Service container started: ${containerId}`);
  return { containerId };
}

export async function deployConfigFile(
  ip: string,
  remotePath: string,
  content: string,
  hostKey?: string
): Promise<void> {
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  await sshExec(ip, `mkdir -p ${dir}`, hostKey);
  const escaped = content.replace(/'/g, "'\\''");
  await sshExec(ip, `echo '${escaped}' > ${remotePath} && chmod 644 ${remotePath}`, hostKey);
}
