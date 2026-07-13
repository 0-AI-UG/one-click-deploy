import { sshExec, describeFailure } from "./ssh.ts";
import { asUser, log } from "./container-common.ts";
import { writeEnvDeployFile } from "./docker-run.ts";

type ComposeOverrideServices = {
  [service: string]: {
    ports?: string[];
    volumes?: string[];
    environment?: Record<string, string>;
    build?: { labels?: string[] };
  };
};

// --- Docker Compose Support (catalog services only) ---

/**
 * Deploy a multi-container *catalog service* from a bundled compose template.
 * There is no git repo — the template ships with OCD and is written straight to
 * the host. Persistent data and the public port are supplied via the generated
 * `docker-compose.ocd.yml` override (the base template declares neither).
 *
 * Services live under `/home/deploy/services/<name>` (NOT the apps dir); pass
 * `baseDir: "/home/deploy/services"` to the compose lifecycle/health helpers
 * for these projects.
 */
export async function pullAndRunComposeService(
  ip: string,
  opts: {
    name: string; // compose project name (== service name)
    composeTemplate: string; // bundled docker-compose.yml text
    webService: string; // service the ingress proxies (gets the published port)
    webPort: number; // that service's internal port
    hostPort: number; // host-side published port
    bindAddr: string; // host bind address (server private IPv4)
    envVars: Record<string, string>;
    /** Per-service bind mounts ("host:container") injected into the override. */
    overrideVolumes: Record<string, string[]>;
    /** Host directories to pre-create (the volume subpaths) before `up`. */
    hostDirs: string[];
  },
  hostKey?: string,
): Promise<void> {
  const svcDir = `/home/deploy/services/${opts.name}`;
  const writeFile = async (path: string, content: string) => {
    const escaped = content.replace(/'/g, "'\\''");
    await sshExec(ip, `echo '${escaped}' > ${path} && chown deploy:deploy ${path}`, hostKey);
  };

  await sshExec(ip, `mkdir -p ${svcDir} && chown deploy:deploy ${svcDir}`, hostKey);

  // Pre-create the volume subpath directories so the bind mounts resolve.
  if (opts.hostDirs.length > 0) {
    const mk = opts.hostDirs.map((d) => `mkdir -p ${d}`).join(" && ");
    await sshExec(ip, `${mk} && chown -R deploy:deploy ${opts.hostDirs.map((d) => d).join(" ")}`, hostKey);
  }

  // Base template (data paths + public port deliberately omitted).
  await writeFile(`${svcDir}/docker-compose.yml`, opts.composeTemplate);

  // Override: publish the web service + inject per-component bind mounts.
  const overrideServices: ComposeOverrideServices = {
    [opts.webService]: {
      ports: [`${opts.bindAddr}:${opts.hostPort}:${opts.webPort}`],
    },
  };
  for (const [svc, vols] of Object.entries(opts.overrideVolumes)) {
    if (vols.length === 0) continue;
    overrideServices[svc] = overrideServices[svc] || {};
    overrideServices[svc].volumes = vols;
  }
  await writeFile(`${svcDir}/docker-compose.ocd.yml`, JSON.stringify({ services: overrideServices }));

  // Env file (secrets, passwords, image tag).
  const envFilePath = await writeEnvDeployFile(ip, opts.name, opts.envVars, hostKey, "/home/deploy/services");
  const envFileFlag = envFilePath ? `--env-file ${envFilePath}` : "";

  const composeCmd = `cd ${svcDir} && docker compose -f docker-compose.yml -f docker-compose.ocd.yml -p ${opts.name} ${envFileFlag} up -d`;
  log("service", `Compose service command: ${composeCmd}`);
  const result = await sshExec(ip, asUser(composeCmd), hostKey);
  if (result.exitCode !== 0) {
    log("service", `Compose service up stderr: ${result.stderr.slice(0, 500)}`);
    throw new Error(describeFailure("Docker Compose service start failed", result));
  }
  log("service", `Compose service ${opts.name} started`);
}

// --- Compose Lifecycle Operations ---

export async function restartCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    asUser(`cd ${appDir} && docker compose -p ${projectName} restart`),
    hostKey
  );
  if (result.exitCode !== 0) {
    throw new Error(describeFailure("Failed to restart compose project", result));
  }
}

export async function pauseCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    asUser(`cd ${appDir} && docker compose -p ${projectName} pause`),
    hostKey
  );
  if (result.exitCode !== 0) {
    // Idempotent, same as pauseContainer: tolerate already-paused containers.
    if (`${result.stdout}\n${result.stderr}`.toLowerCase().includes("already paused")) return;
    throw new Error(describeFailure("Failed to pause compose project", result));
  }
}

export async function unpauseCompose(ip: string, projectName: string, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    asUser(`cd ${appDir} && docker compose -p ${projectName} unpause`),
    hostKey
  );
  if (result.exitCode !== 0) {
    // Idempotent, same as unpauseContainer: tolerate not-paused containers.
    if (`${result.stdout}\n${result.stderr}`.toLowerCase().includes("is not paused")) return;
    throw new Error(describeFailure("Failed to unpause compose project", result));
  }
}

export async function removeCompose(ip: string, projectName: string, removeVolumes = false, hostKey?: string, baseDir = "/home/deploy/apps") {
  const appDir = `${baseDir}/${projectName}`;
  const volFlag = removeVolumes ? " -v" : "";
  await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} down${volFlag} 2>/dev/null || true"`,
    hostKey
  );
}

export async function getComposeLogs(
  ip: string,
  projectName: string,
  tail: number = 100,
  hostKey?: string,
  baseDir = "/home/deploy/apps"
): Promise<string> {
  const appDir = `${baseDir}/${projectName}`;
  const result = await sshExec(
    ip,
    `su - deploy -c "cd ${appDir} && docker compose -p ${projectName} logs --tail ${tail} 2>&1"`,
    hostKey
  );
  return result.stdout;
}
