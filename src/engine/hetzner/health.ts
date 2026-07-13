import { sshExec } from "./ssh.ts";
import { asUser, log } from "./container-common.ts";

// `inconclusive` means the probe itself couldn't run (the SSH connection to the
// host was dropped/refused — e.g. sshd MaxStartups throttling the reconciler's
// per-tick burst), NOT that the container is down. Callers must treat it as
// "unknown" and leave the existing status untouched rather than flip to
// unhealthy on what is really a transport hiccup.
type HealthResult = { healthy: boolean; statusCode?: number; error?: string; inconclusive?: boolean };

// `ssh` exits 255 only when the transport fails (connection closed/refused/
// timed out during the handshake) — remote command exit codes pass through
// unchanged (curl uses 7/28/…, `docker inspect` a missing container uses 1), so
// 255 cleanly separates "couldn't reach the host" from "the check ran and
// failed".
const SSH_TRANSPORT_FAILURE = 255;

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
// `sshFailed` distinguishes a dropped SSH connection (transport hiccup) from an
// authoritative "not running" so callers don't misread the former as a crash.
async function inspectRunning(
  ip: string,
  containerName: string,
  hostKey?: string,
): Promise<{ running: boolean; sshFailed: boolean }> {
  const inspect = await sshExec(
    ip,
    asUser(`docker inspect --format='{{.State.Running}}' ${containerName} 2>/dev/null`),
    hostKey,
  );
  if (inspect.exitCode === SSH_TRANSPORT_FAILURE) return { running: false, sshFailed: true };
  return { running: inspect.stdout.trim() === "true", sshFailed: false };
}

// Normalize a configured health path into a curl-safe request path. Empty
// (the default for apps.health_check_path) probes the root; a value without a
// leading slash gets one so `curl` builds a valid URL.
function probePath(path?: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

// HTTP probe on the container's published port (runs as root, no su hop).
// `path` is the app's configured health-check path (defaults to `/`), so the
// post-deploy probe hits the same endpoint Traefik's active check uses.
async function httpProbe(
  ip: string,
  bindHost: string,
  port: number,
  hostKey?: string,
  path?: string,
): Promise<{ statusCode: number; sshFailed: boolean }> {
  const curl = await sshExec(
    ip,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://${bindHost}:${port}${probePath(path)}`,
    hostKey,
  );
  if (curl.exitCode === SSH_TRANSPORT_FAILURE) return { statusCode: NaN, sshFailed: true };
  return { statusCode: parseInt(curl.stdout.trim(), 10), sshFailed: false };
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
  path?: string,
): Promise<ProbeStep> {
  const { statusCode, sshFailed } = await httpProbe(ip, bindHost, port, hostKey, path);
  if (sshFailed) return inconclusiveStep(attempt, maxAttempts);
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

// A probe attempt that couldn't reach the host at all. Returned as a
// non-terminal step so a multi-attempt probe still retries, but its
// `finalResult` is flagged `inconclusive` so single-attempt callers (the
// reconciler) skip the tick instead of recording a false unhealthy.
function inconclusiveStep(attempt: number, maxAttempts: number): ProbeStep {
  return {
    done: false,
    retryLog: `probe could not reach host over SSH (attempt ${attempt + 1}/${maxAttempts})`,
    finalResult: { healthy: false, inconclusive: true, error: "probe transport failed (ssh unreachable)" },
  };
}

export async function healthCheck(
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string,
  path?: string,
): Promise<HealthResult> {
  return runHealthProbe(
    `Checking health of ${containerName} on ${ip} via ${bindHost}:${port}${probePath(path)}`,
    maxAttempts,
    async (i) => {
      const inspect = await inspectRunning(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      if (!inspect.running) {
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
        "Health check passed", "Health check returned", hostKey, path,
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
      const inspect = await inspectRunning(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      if (inspect.running) {
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
  app: { health_check: number; health_check_path?: string | null },
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string,
): Promise<{ healthy: boolean; statusCode?: number; error?: string; inconclusive?: boolean }> {
  return app.health_check
    ? healthCheck(ip, containerName, bindHost, port, maxAttempts, hostKey, app.health_check_path ?? undefined)
    : containerRunningCheck(ip, containerName, maxAttempts, hostKey);
}

export async function serviceHealthCheck(
  ip: string,
  containerName: string,
  healthCmd: string,
  maxAttempts = 5,
  hostKey?: string
): Promise<{ healthy: boolean; error?: string; inconclusive?: boolean }> {
  return runHealthProbe(
    `Service health check for ${containerName}: ${healthCmd}`,
    maxAttempts,
    async (i) => {
      const inspect = await inspectRunning(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      if (!inspect.running) {
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

      if (result.exitCode === SSH_TRANSPORT_FAILURE) return inconclusiveStep(i, maxAttempts);
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
