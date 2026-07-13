import { sshExec } from "./ssh.ts";
import { asUser, log } from "./container-common.ts";

type HealthResult = { healthy: boolean; statusCode?: number; error?: string };

// One attempt's outcome: either terminal (return `result`, with an optional
// log line) or a retry directive that also carries the result to return when
// this was the final attempt.
type ProbeStep =
  | { done: true; log?: string; result: HealthResult }
  | { done: false; retryLog: string; finalResult: HealthResult };

/**
 * Shared retry loop for every health probe: log the intro once, then run
 * `step` up to `maxAttempts` times, sleeping 3s between attempts. `step`
 * encapsulates the per-variant running-check + probe stage and returns whether
 * it terminated. On the last attempt a non-terminal step returns its
 * `finalResult` instead of retrying.
 */
async function runHealthProbe(
  introLog: string,
  maxAttempts: number,
  step: (attempt: number) => Promise<ProbeStep>,
): Promise<HealthResult> {
  log("health", introLog);
  for (let i = 0; i < maxAttempts; i++) {
    const outcome = await step(i);
    if (outcome.done) {
      if (outcome.log) log("health", outcome.log);
      return outcome.result;
    }
    if (i < maxAttempts - 1) {
      log("health", outcome.retryLog);
      await Bun.sleep(3000);
    } else {
      return outcome.finalResult;
    }
  }
  return { healthy: false, error: "Health check timed out" };
}

// Running-check via `docker inspect` (shared by the container-scoped probes).
async function inspectRunning(ip: string, containerName: string, hostKey?: string): Promise<boolean> {
  const inspect = await sshExec(
    ip,
    asUser(`docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`),
    hostKey,
  );
  return inspect.stdout.trim() === "true";
}

// HTTP probe on the container's published port (runs as root, no su hop).
async function httpProbe(ip: string, bindHost: string, port: number, hostKey?: string): Promise<number> {
  const curl = await sshExec(
    ip,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${bindHost}:${port}/`,
    hostKey,
  );
  return parseInt(curl.stdout.trim(), 10);
}

// Shared probe stage for the two HTTP variants: given a running container,
// curl its port and translate the status code into a ProbeStep.
async function httpProbeStep(
  ip: string,
  bindHost: string,
  port: number,
  attempt: number,
  maxAttempts: number,
  passLabel: string,
  retryLabel: string,
  hostKey?: string,
): Promise<ProbeStep> {
  const statusCode = await httpProbe(ip, bindHost, port, hostKey);
  if (statusCode >= 200 && statusCode < 500) {
    return { done: true, log: `${passLabel}: HTTP ${statusCode}`, result: { healthy: true, statusCode } };
  }
  return {
    done: false,
    retryLog: `${retryLabel} ${statusCode} (attempt ${attempt + 1}/${maxAttempts})`,
    finalResult: {
      healthy: false,
      statusCode: isNaN(statusCode) ? undefined : statusCode,
      error: `Health check failed with HTTP ${statusCode || "no response"}`,
    },
  };
}

export async function composeHealthCheck(
  ip: string,
  projectName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string,
  baseDir = "/home/deploy/apps"
): Promise<HealthResult> {
  return runHealthProbe(
    `Checking compose health of ${projectName} on ${ip} via ${bindHost}:${port}`,
    maxAttempts,
    async (i) => {
      // Check all services are running via `docker compose ps --format json`.
      const appDir = `${baseDir}/${projectName}`;
      const ps = await sshExec(
        ip,
        asUser(`cd ${appDir} && docker compose -p ${projectName} ps --format json 2>/dev/null`),
        hostKey,
      );
      if (ps.exitCode !== 0) {
        return {
          done: false,
          retryLog: `Compose ps failed (attempt ${i + 1}/${maxAttempts})`,
          finalResult: { healthy: false, error: "Failed to check compose services" },
        };
      }

      // Parse service statuses — docker compose ps --format json outputs one JSON per line
      const lines = ps.stdout.trim().split("\n").filter(Boolean);
      let allRunning = lines.length > 0;
      for (const line of lines) {
        try {
          const svc = JSON.parse(line);
          if (svc.State !== "running") {
            allRunning = false;
            break;
          }
        } catch {
          allRunning = false;
          break;
        }
      }

      if (!allRunning) {
        return {
          done: false,
          retryLog: `Not all compose services running yet (attempt ${i + 1}/${maxAttempts})`,
          finalResult: { healthy: false, error: "Not all compose services are running" },
        };
      }

      // Check HTTP response on the web service's published port. `bindHost`
      // is the address the container's `-p` flag publishes on — usually the
      // server's private IPv4 for tenant apps, or 127.0.0.1 for the panel.
      return httpProbeStep(
        ip, bindHost, port, i, maxAttempts,
        "Compose health check passed", "Compose health check returned", hostKey,
      );
    },
  );
}

export async function healthCheck(
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string
): Promise<HealthResult> {
  return runHealthProbe(
    `Checking health of ${containerName} on ${ip} via ${bindHost}:${port}`,
    maxAttempts,
    async (i) => {
      if (!(await inspectRunning(ip, containerName, hostKey))) {
        return {
          done: false,
          retryLog: `Container not running yet (attempt ${i + 1}/${maxAttempts})`,
          finalResult: { healthy: false, error: "Container is not running" },
        };
      }
      // Check HTTP response on the container's published port. `bindHost`
      // is whatever address the container is bound to — typically the
      // server's private IPv4 for tenant apps, 127.0.0.1 for the panel.
      return httpProbeStep(
        ip, bindHost, port, i, maxAttempts,
        "Health check passed", "Health check returned", hostKey,
      );
    },
  );
}

/**
 * Running-only health check for apps with the HTTP probe disabled
 * (apps.health_check = 0): databases, queue workers and other containers
 * that don't speak HTTP on their exposed port. Same docker-inspect retry
 * loop and result shape as healthCheck, minus the curl.
 */
export async function containerRunningCheck(
  ip: string,
  containerName: string,
  maxAttempts = 5,
  hostKey?: string
): Promise<HealthResult> {
  return runHealthProbe(
    `HTTP probe disabled for ${containerName} on ${ip}; verifying container is running`,
    maxAttempts,
    async (i) => {
      if (await inspectRunning(ip, containerName, hostKey)) {
        return { done: true, log: `HTTP probe disabled; container is running`, result: { healthy: true } };
      }
      return {
        done: false,
        retryLog: `Container not running yet (attempt ${i + 1}/${maxAttempts})`,
        finalResult: { healthy: false, error: "Container is not running" },
      };
    },
  );
}

/**
 * The app-health probe every deploy/scale/restart path shares: an HTTP probe
 * (healthCheck) when `app.health_check` is on, else a running-only probe
 * (containerRunningCheck) for databases/workers that don't speak HTTP. Same
 * result shape either way.
 */
export async function probeAppHealth(
  app: { health_check: number },
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string,
): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
  return app.health_check
    ? healthCheck(ip, containerName, bindHost, port, maxAttempts, hostKey)
    : containerRunningCheck(ip, containerName, maxAttempts, hostKey);
}

export async function serviceHealthCheck(
  ip: string,
  containerName: string,
  healthCmd: string,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; error?: string }> {
  return runHealthProbe(
    `Service health check for ${containerName}: ${healthCmd}`,
    maxAttempts,
    async (i) => {
      if (!(await inspectRunning(ip, containerName, hostKey))) {
        return {
          done: false,
          retryLog: `Service container not running yet (attempt ${i + 1}/${maxAttempts})`,
          finalResult: { healthy: false, error: "Container is not running" },
        };
      }

      // Run health check command inside container
      const result = await sshExec(
        ip,
        `su - deploy -c "docker exec ${containerName} sh -c '${healthCmd.replace(/'/g, "'\\''")}'  2>&1"`,
        hostKey
      );

      if (result.exitCode === 0) {
        return { done: true, log: `Service health check passed for ${containerName}`, result: { healthy: true } };
      }
      return {
        done: false,
        retryLog: `Service health check failed (attempt ${i + 1}/${maxAttempts}): ${result.stdout.trim()}`,
        finalResult: { healthy: false, error: `Health check failed: ${result.stdout.trim() || result.stderr.trim()}` },
      };
    },
  );
}
