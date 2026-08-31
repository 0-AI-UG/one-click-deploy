import { sshExec } from "./ssh.ts";
import { asUser, log } from "./container-common.ts";

// `inconclusive` means the probe itself couldn't run (the SSH connection to the
// host was dropped/refused — e.g. sshd MaxStartups throttling the reconciler's
// per-tick burst), NOT that the container is down. Callers must treat it as
// "unknown" and leave the existing status untouched rather than flip to
// unhealthy on what is really a transport hiccup.
type HealthResult = {
  /** Ready to receive the workload's expected traffic/work. */
  healthy: boolean;
  /** Docker reports the process as running. A running process is not
   * necessarily ready (HTTP/exec probes may still fail). */
  running?: boolean;
  /** Explicit readiness alias for API/diagnostic callers. */
  ready?: boolean;
  statusCode?: number;
  error?: string;
  inconclusive?: boolean;
  containerStatus?: string;
  restartCount?: number;
};

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

export function isExpectedHttpStatus(statusCode: number, expectedStatuses: number[] = [200]): boolean {
  return expectedStatuses.includes(statusCode);
}

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

export type ContainerInspection = {
  status: string;
  running: boolean;
  restarting: boolean;
  restartCount: number;
  startedAt: string | null;
};

const RESTART_LOOP_THRESHOLD = 5;
const RESTART_LOOP_WINDOW_MS = 5 * 60_000;

/** Parse the tab-separated, single-line docker-inspect format used below. */
export function parseContainerInspection(raw: string): ContainerInspection | null {
  const normalized = raw.trim().replace(/\\t/g, "\t");
  const [status = "", runningRaw = "", restartingRaw = "", restartRaw = "", startedAtRaw = ""] =
    normalized.split("\t");
  if (!status) return null;
  const restartCount = Number(restartRaw);
  return {
    status,
    running: runningRaw === "true",
    restarting: restartingRaw === "true",
    restartCount: Number.isFinite(restartCount) ? restartCount : 0,
    startedAt: startedAtRaw && !startedAtRaw.startsWith("0001-") ? startedAtRaw : null,
  };
}

/**
 * Docker "running" is process state, not readiness. Reject explicit
 * restarting/exited/dead states and a young container with a high restart
 * count (a restart loop). A formerly unstable container becomes eligible
 * again after it has remained up for the full stability window.
 */
export function assessContainerInspection(
  state: ContainerInspection,
  nowMs = Date.now(),
): { runnable: boolean; error?: string } {
  if (state.restarting || state.status === "restarting") {
    return { runnable: false, error: `Container is restarting (restart count ${state.restartCount})` };
  }
  if (!state.running || state.status !== "running") {
    return { runnable: false, error: `Container state is ${state.status || "unknown"}` };
  }
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const recentlyStarted = Number.isFinite(startedMs) && nowMs - startedMs < RESTART_LOOP_WINDOW_MS;
  if (state.restartCount >= RESTART_LOOP_THRESHOLD && recentlyStarted) {
    return {
      runnable: false,
      error: `Container restarted ${state.restartCount} times and has not remained stable for 5 minutes`,
    };
  }
  return { runnable: true };
}

// Container-state check via `docker inspect` (shared by the container-scoped
// probes). `sshFailed` distinguishes a dropped SSH connection from an
// authoritative container state so callers don't misread transport as a crash.
async function inspectContainer(
  ip: string,
  containerName: string,
  hostKey?: string,
): Promise<{ state: ContainerInspection | null; sshFailed: boolean }> {
  const inspect = await sshExec(
    ip,
    asUser(
      `docker inspect --format='{{.State.Status}}\\t{{.State.Running}}\\t{{.State.Restarting}}\\t{{.RestartCount}}\\t{{.State.StartedAt}}' ${containerName} 2>/dev/null`,
    ),
    hostKey,
  );
  if (inspect.exitCode === SSH_TRANSPORT_FAILURE) return { state: null, sshFailed: true };
  return { state: parseContainerInspection(inspect.stdout), sshFailed: false };
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
  expectedStatuses: number[] = [200],
): Promise<ProbeStep> {
  const { statusCode, sshFailed } = await httpProbe(ip, bindHost, port, hostKey, path);
  if (sshFailed) return inconclusiveStep(attempt, maxAttempts);
  if (isExpectedHttpStatus(statusCode, expectedStatuses)) {
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
  expectedStatuses: number[] = [200],
): Promise<HealthResult> {
  return runHealthProbe(
    `Checking health of ${containerName} on ${ip} via ${bindHost}:${port}${probePath(path)}`,
    maxAttempts,
    async (i) => {
      const inspect = await inspectContainer(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      const assessment = inspect.state ? assessContainerInspection(inspect.state) : {
        runnable: false,
        error: "Container does not exist",
      };
      if (!assessment.runnable) {
        return {
          done: false,
          retryLog: `${assessment.error} (attempt ${i + 1}/${maxAttempts})`,
          finalResult: {
            healthy: false,
            running: false,
            ready: false,
            error: assessment.error,
            containerStatus: inspect.state?.status,
            restartCount: inspect.state?.restartCount,
          },
        };
      }
      // Check HTTP response on the container's published port. `bindHost`
      // is whatever address the container is bound to — typically the
      // server's private IPv4 for tenant apps, 127.0.0.1 for the panel.
      const outcome = await httpProbeStep(
        ip, bindHost, port, i, maxAttempts,
        "Health check passed", "Health check returned", hostKey, path, expectedStatuses,
      );
      if (outcome.done) {
        return {
          ...outcome,
          result: {
            ...outcome.result,
            running: true,
            ready: outcome.result.healthy,
            containerStatus: inspect.state?.status,
            restartCount: inspect.state?.restartCount,
          },
        };
      }
      return {
        ...outcome,
        finalResult: {
          ...outcome.finalResult,
          running: true,
          ready: false,
          containerStatus: inspect.state?.status,
          restartCount: inspect.state?.restartCount,
        },
      };
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
  let stableInspections = 0;
  let observedRestartCount: number | undefined;
  return runHealthProbe(
    `HTTP probe disabled for ${containerName} on ${ip}; verifying container remains running`,
    maxAttempts,
    async (i) => {
      const inspect = await inspectContainer(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      const assessment = inspect.state ? assessContainerInspection(inspect.state) : {
        runnable: false,
        error: "Container does not exist",
      };
      if (assessment.runnable) {
        if (maxAttempts === 1) {
          return {
            done: true,
            log: "HTTP probe disabled; container is running",
            result: {
              healthy: true,
              running: true,
              ready: true,
              containerStatus: inspect.state?.status,
              restartCount: inspect.state?.restartCount,
            },
          };
        }
        const restartCount = inspect.state?.restartCount ?? 0;
        if (observedRestartCount === undefined || restartCount === observedRestartCount) {
          stableInspections++;
        } else {
          stableInspections = 1;
        }
        observedRestartCount = restartCount;
        if (stableInspections < maxAttempts) {
          const error = `Container has remained running for ${stableInspections}/${maxAttempts} stability checks`;
          return {
            done: false,
            retryLog: error,
            finalResult: {
              healthy: false,
              running: true,
              ready: false,
              error: `Container did not remain stable for ${maxAttempts} consecutive checks`,
              containerStatus: inspect.state?.status,
              restartCount,
            },
          };
        }
        return {
          done: true,
          log: `HTTP probe disabled; container remained stable for ${maxAttempts} checks`,
          result: {
            healthy: true,
            running: true,
            ready: true,
            containerStatus: inspect.state?.status,
            restartCount: inspect.state?.restartCount,
          },
        };
      }
      return {
        done: false,
        retryLog: `${assessment.error} (attempt ${i + 1}/${maxAttempts})`,
        finalResult: {
          healthy: false,
          running: false,
          ready: false,
          error: assessment.error,
          containerStatus: inspect.state?.status,
          restartCount: inspect.state?.restartCount,
        },
      };
    },
  );
}

/**
 * Pass a script to `docker exec ... sh` over stdin instead of nesting it in
 * several shell quote layers. This preserves catalog commands containing both
 * quote styles (notably PostgreSQL's post-start SQL command).
 */
export function dockerExecScriptCommand(containerName: string, script: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error("Invalid container name for health command");
  }
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return asUser(`printf '%s' '${encoded}' | base64 -d | docker exec -i ${containerName} sh 2>&1`);
}

/**
 * The app-health probe every deploy/scale/restart path shares: an HTTP probe
 * (healthCheck) when `app.health_check` is on, else a running-only probe
 * (containerRunningCheck) for databases/workers that don't speak HTTP. Same
 * result shape either way.
 */
export async function probeAppHealth(
  app: {
    health_check: number;
    health_check_path?: string | null;
    health_check_mode?: string | null;
    health_check_command?: string | null;
    health_check_file?: string | null;
    health_check_max_age_seconds?: number | null;
    health_check_expected_statuses?: string | number[] | null;
  },
  ip: string,
  containerName: string,
  bindHost: string,
  port: number,
  maxAttempts = 5,
  hostKey?: string,
): Promise<{ healthy: boolean; statusCode?: number; error?: string; inconclusive?: boolean }> {
  const mode = app.health_check_mode || (app.health_check ? "http" : "container");
  if (mode === "http") {
    let expectedStatuses = [200];
    if (Array.isArray(app.health_check_expected_statuses)) {
      expectedStatuses = app.health_check_expected_statuses;
    } else if (typeof app.health_check_expected_statuses === "string") {
      try {
        const parsed = JSON.parse(app.health_check_expected_statuses);
        if (Array.isArray(parsed) && parsed.every((value) => Number.isInteger(value))) expectedStatuses = parsed;
      } catch { /* legacy/invalid state falls back to strict HTTP 200 */ }
    }
    return healthCheck(
      ip, containerName, bindHost, port, maxAttempts, hostKey,
      app.health_check_path ?? undefined, expectedStatuses,
    );
  }
  if (mode === "exec") {
    if (!app.health_check_command) return { healthy: false, error: "Exec health check command is missing" };
    return execHealthCheck(ip, containerName, app.health_check_command, maxAttempts, hostKey);
  }
  if (mode === "heartbeat" || mode === "periodic_job") {
    if (!app.health_check_file || !app.health_check_max_age_seconds) {
      return { healthy: false, error: `${mode} health check marker file/max age is missing` };
    }
    return markerFreshnessHealthCheck(
      ip,
      containerName,
      app.health_check_file,
      app.health_check_max_age_seconds,
      mode,
      maxAttempts,
      hostKey,
    );
  }
  // `container` is an explicit opt-out from readiness probing. A single
  // docker-inspect (which still rejects restarting/exited/restart-loop state)
  // is authoritative and avoids turning final bookkeeping into a 30s+ wait.
  return containerRunningCheck(ip, containerName, 1, hostKey);
}

async function execHealthCheck(
  ip: string,
  containerName: string,
  command: string,
  maxAttempts: number,
  hostKey?: string,
): Promise<{ healthy: boolean; error?: string; inconclusive?: boolean }> {
  return runHealthProbe(`Exec health check for ${containerName}: ${command}`, maxAttempts, async (i) => {
    const inspect = await inspectContainer(ip, containerName, hostKey);
    if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
    const assessment = inspect.state
      ? assessContainerInspection(inspect.state)
      : { runnable: false, error: "Container does not exist" };
    if (!assessment.runnable) {
      return {
        done: false,
        retryLog: `${assessment.error} (attempt ${i + 1}/${maxAttempts})`,
        finalResult: { healthy: false, running: false, ready: false, error: assessment.error },
      };
    }
    const result = await sshExec(ip, dockerExecScriptCommand(containerName, command), hostKey);
    if (result.exitCode === SSH_TRANSPORT_FAILURE) return inconclusiveStep(i, maxAttempts);
    if (result.exitCode === 0) {
      return { done: true, log: `Exec health check passed for ${containerName}`, result: { healthy: true } };
    }
    const error = result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`;
    return {
      done: false,
      retryLog: `Exec health check failed (attempt ${i + 1}/${maxAttempts}): ${error}`,
      finalResult: { healthy: false, error: `Health check failed: ${error}` },
    };
  });
}

/** Pure marker assessment used by probes and unit tests. */
export function assessMarkerFreshness(
  modifiedEpochSeconds: number,
  maxAgeSeconds: number,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): { fresh: boolean; ageSeconds: number } {
  const ageSeconds = Math.max(0, nowEpochSeconds - modifiedEpochSeconds);
  return { fresh: Number.isFinite(modifiedEpochSeconds) && ageSeconds <= maxAgeSeconds, ageSeconds };
}

export async function markerFreshnessHealthCheck(
  ip: string,
  containerName: string,
  markerFile: string,
  maxAgeSeconds: number,
  label: "heartbeat" | "periodic_job",
  maxAttempts = 5,
  hostKey?: string,
): Promise<{ healthy: boolean; error?: string; inconclusive?: boolean }> {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(markerFile)) {
    return { healthy: false, error: `Invalid ${label} marker path` };
  }
  return runHealthProbe(
    `${label} freshness check for ${containerName}: ${markerFile} <= ${maxAgeSeconds}s`,
    maxAttempts,
    async (i) => {
      const inspect = await inspectContainer(ip, containerName, hostKey);
      if (inspect.sshFailed) return inconclusiveStep(i, maxAttempts);
      const assessment = inspect.state ? assessContainerInspection(inspect.state) : {
        runnable: false,
        error: "Container does not exist",
      };
      if (!assessment.runnable) {
        return {
          done: false,
          retryLog: `${assessment.error} (attempt ${i + 1}/${maxAttempts})`,
          finalResult: { healthy: false, running: false, ready: false, error: assessment.error },
        };
      }
      const result = await sshExec(
        ip,
        asUser(`docker exec ${containerName} stat -c %Y ${markerFile}`),
        hostKey,
      );
      if (result.exitCode === SSH_TRANSPORT_FAILURE) return inconclusiveStep(i, maxAttempts);
      const modified = Number(result.stdout.trim());
      const freshness = assessMarkerFreshness(modified, maxAgeSeconds);
      if (result.exitCode === 0 && freshness.fresh) {
        return {
          done: true,
          log: `${label} marker is fresh (${freshness.ageSeconds}s old)`,
          result: { healthy: true, running: true, ready: true },
        };
      }
      const error = result.exitCode === 0 && Number.isFinite(modified)
        ? `${label} marker is stale (${freshness.ageSeconds}s old; maximum ${maxAgeSeconds}s)`
        : `${label} marker file ${markerFile} is missing or unreadable`;
      return {
        done: false,
        retryLog: `${error} (attempt ${i + 1}/${maxAttempts})`,
        finalResult: { healthy: false, running: true, ready: false, error },
      };
    },
  );
}
