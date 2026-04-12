import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import { parseEnvVars, maskEnvVarsForResponse, serializeEnvVars, mergeEnvVarUpdate, processIncomingEnvVars } from "../../bun/env-crypto.ts";
import type { AppRow } from "../../bun/db/apps.ts";
import {
  deploy,
  destroyApp,
  getServersWithApps,
  restartApp,
  pauseApp,
  unpauseApp,
  redeployApp,
  updateAppEnv,
  rollbackApp,
} from "../../bun/deploy/index.ts";
import { sshExec, getComposeLogs, getContainerLogs } from "../../bun/remote/index.ts";
import { validateAppName } from "../../bun/validate.ts";
import { introspectRepo } from "../../bun/github-introspect.ts";
import { tryAcquireLock } from "../../bun/op-lock.ts";

/** Mask env_vars in an app row for API responses. */
function maskAppEnvVars(app: AppRow & Record<string, unknown>) {
  const parsed = parseEnvVars(app.env_vars);
  return {
    ...app,
    env_vars: maskEnvVarsForResponse(parsed),
    environment_id: app.environment_id ?? null,
  };
}

// In-process notifier for long-poll waiters. Keyed by deploy job id; each
// waiter is a no-arg callback that resolves the long-poll Promise.
// Exported so other route modules (e.g. scaling) can plug into the same
// deploy_jobs table and the existing long-poll endpoint without standing up
// their own job system.
const jobWaiters = new Map<number, Set<() => void>>();

export function notifyJob(jobId: number) {
  const set = jobWaiters.get(jobId);
  if (!set) return;
  for (const w of set) w();
}

export function waitForJob(jobId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      jobWaiters.get(jobId)?.delete(wake);
      if (jobWaiters.get(jobId)?.size === 0) jobWaiters.delete(jobId);
      clearTimeout(timer);
      resolve();
    };
    const wake = () => finish();
    if (!jobWaiters.has(jobId)) jobWaiters.set(jobId, new Set());
    jobWaiters.get(jobId)!.add(wake);
    const timer = setTimeout(finish, timeoutMs);
  });
}

export async function handleIntrospectRepo(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const url = new URL(request.url).searchParams.get("url") || "";
    if (!url) {
      return Response.json(
        { ok: false, error: "Missing repo URL" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await introspectRepo(url, payload.userId);
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const result = getServersWithApps().map((s: any) => ({
      ...s,
      apps: (s.apps || []).map((a: any) => maskAppEnvVars(a)),
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDashboard(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const apps = db.getApps().map((a) => {
      const reps = db.getReplicas(a.id);
      return maskAppEnvVars({ ...a, desired_replicas: a.desired_replicas ?? reps.length });
    });
    const services = db.getServices().map((svc) => {
      const instances = db.getServiceInstances(svc.id);
      const links = db.getServiceLinks(svc.id);
      return {
        ...svc,
        instance_count: instances.length,
        linked_apps: links.map((l) => ({ id: l.app_id, name: l.app_name })),
      };
    });
    return Response.json({ apps, services }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetApps(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const apps = db.getApps();
    const result = apps.map((a) => {
      const reps = db.getReplicas(a.id);
      const first = reps[0];
      const servers = db.getServersForApp(a.id).map((s) => s.id);
      return maskAppEnvVars({ ...a, host_port: first?.host_port ?? 0, servers });
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeploy(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const req = await request.json();

    // Create a durable job row before kicking off the deploy. The client
    // long-polls /api/deploy-jobs/:id to watch progress.
    const job = db.createDeployJob(req.app_name);

    // Run the deploy in the background. Each progress callback persists an
    // event row and wakes any long-poll waiters.
    (async () => {
      try {
        const result = await deploy(req, (step, detail) => {
          db.appendDeployJobEvent(job.id, step, detail);
          notifyJob(job.id);
        }, payload.userId);
        db.finishDeployJob(job.id, result);
        if (result.ok) db.deleteDeploySession(payload.userId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.appendDeployJobEvent(job.id, "error", msg);
        db.finishDeployJob(job.id, { ok: false, error: msg });
      } finally {
        notifyJob(job.id);
      }
    })();

    return Response.json({ deployment_id: job.id }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export const LONG_POLL_TIMEOUT_MS = 25_000;

export async function handleDeployJobPoll(request: Request, jobId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;

    const job = db.getDeployJob(jobId);
    if (!job) {
      return Response.json({ error: "Deploy job not found" }, { status: 404, headers: corsHeaders });
    }

    let events = db.getDeployJobEvents(jobId, since);

    // If there's nothing new and the job is still running, block until either
    // a new event arrives, the job finishes, or the long-poll times out.
    if (events.length === 0 && job.status === "running") {
      await Promise.race([
        waitForJob(jobId, LONG_POLL_TIMEOUT_MS),
        new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve())),
      ]);
      events = db.getDeployJobEvents(jobId, since);
    }

    const fresh = db.getDeployJob(jobId)!;
    const result = fresh.result_json ? JSON.parse(fresh.result_json) : null;
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : since;

    return Response.json(
      {
        status: fresh.status, // 'running' | 'done' | 'error'
        events,
        last_seq: lastSeq,
        result, // null while running, {ok, error?} once finished
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.destroy");
    const lock = tryAcquireLock(`app:${appId}`, "destroy");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await destroyApp(appId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.restart");
    const lock = tryAcquireLock(`app:${appId}`, "restart");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await restartApp(appId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePauseApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const lock = tryAcquireLock(`app:${appId}`, "pause");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await pauseApp(appId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.pause");
    const lock = tryAcquireLock(`app:${appId}`, "unpause");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await unpauseApp(appId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.redeploy");
    const body = (await request.json().catch(() => ({}))) as {
      env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
      auth_password?: string | null;
      container_port?: number;
      environment_id?: number | null;
    };

    if (body.container_port !== undefined) {
      const p = Number(body.container_port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return Response.json({ ok: false, error: "Port must be an integer between 1 and 65535" }, { headers: corsHeaders });
      }
      body.container_port = p;
    }

    // Process env vars through the new format
    let resolvedEnvVars: Record<string, string> | undefined;
    if (body.env_vars) {
      const app = db.getApp(appId);
      if (app) {
        const existingParsed = parseEnvVars(app.env_vars);
        const incoming = Array.isArray(body.env_vars)
          ? body.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret ?? false }))
          : Object.entries(body.env_vars).map(([key, value]) => ({ key, value, secret: false }));
        const merged = await mergeEnvVarUpdate(existingParsed, incoming);
        db.updateAppEnvVars(appId, serializeEnvVars(merged.entries));
      }
    }

    if (body.environment_id !== undefined) {
      db.updateAppEnvironment(appId, body.environment_id);
    }

    const lock = tryAcquireLock(`app:${appId}`, "redeploy");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      // Pass undefined for env_vars since we already persisted them above
      const result = await redeployApp(appId, () => {}, undefined, body.auth_password, body.container_port, payload.userId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateAppEnv(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.env");
    const body = await request.json() as {
      env_vars: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
    };

    // Process through the new format, then pass flat map to existing updateAppEnv
    const app = db.getApp(appId);
    if (!app) {
      return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });
    }
    const existingParsed = parseEnvVars(app.env_vars);
    const incoming = Array.isArray(body.env_vars)
      ? body.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret ?? false }))
      : Object.entries(body.env_vars).map(([key, value]) => ({ key, value, secret: false }));
    const merged = await mergeEnvVarUpdate(existingParsed, incoming);
    db.updateAppEnvVars(appId, serializeEnvVars(merged.entries));

    const lock = tryAcquireLock(`app:${appId}`, "updateEnv");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await updateAppEnv(appId, undefined as any, payload.userId);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}
export async function handleRenameApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.deploy");
    const { name } = await request.json() as { name: string };

    const nameResult = validateAppName(name);
    if (!nameResult.valid) {
      return Response.json({ error: nameResult.error }, { status: 400, headers: corsHeaders });
    }
    const newName = nameResult.value;

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    if (newName === app.name) {
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    const existing = db.getAppByName(newName);
    if (existing) {
      return Response.json({ error: `An app named "${newName}" already exists` }, { status: 409, headers: corsHeaders });
    }

    const lock = tryAcquireLock(`app:${appId}`, "rename");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      // Rename container and directory on each server hosting a replica
      const replicas = db.getReplicas(appId);
      for (const replica of replicas) {
        const server = db.getServer(replica.server_id);
        if (!server) continue;
        const hostKey = server.ssh_host_key || undefined;

        if (app.deploy_mode === "compose") {
          await sshExec(
            server.ipv4,
            `su - deploy -c "mv /home/deploy/apps/${app.name} /home/deploy/apps/${newName} 2>/dev/null || true"`,
            hostKey
          );
        } else {
          await sshExec(
            server.ipv4,
            `su - deploy -c "docker rename ${app.name} ${newName} 2>/dev/null || true"`,
            hostKey
          );
          await sshExec(
            server.ipv4,
            `su - deploy -c "mv /home/deploy/apps/${app.name} /home/deploy/apps/${newName} 2>/dev/null || true"`,
            hostKey
          );
        }
      }

      db.renameApp(appId, newName);
      return Response.json({ ok: true, name: newName }, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetContainerLogs(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const url = new URL(request.url);
    const tail = parseInt(url.searchParams.get("tail") || "100", 10);
    const replicaIdParam = url.searchParams.get("replica_id");

    const app = db.getApp(appId);
    if (!app) return Response.json({ logs: "", error: "App not found" }, { headers: corsHeaders });
    const replicas = db.getReplicas(appId);
    if (replicas.length === 0) return Response.json({ logs: "", error: "App has no replicas" }, { headers: corsHeaders });

    let replica = replicas[0];
    if (replicaIdParam) {
      const requested = replicas.find((r) => r.id === parseInt(replicaIdParam, 10));
      if (!requested) return Response.json({ logs: "", error: "Replica not found" }, { headers: corsHeaders });
      replica = requested;
    }

    const server = db.getServer(replica.server_id);
    if (!server) return Response.json({ logs: "", error: "Server not found" }, { headers: corsHeaders });

    const logs = app.deploy_mode === "compose"
      ? await getComposeLogs(server.ipv4, app.name, tail, server.ssh_host_key || undefined)
      : await getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined);

    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployLog(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const log = db.getDeployLog(appId);
    return Response.json({ log }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployments(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs");
    const deployments = db.getDeployments(appId);
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.rollback");
    const body = await request.json() as { deployment_id: number };
    const lock = tryAcquireLock(`app:${appId}`, "rollback");
    if ("busy" in lock) {
      return Response.json({ ok: false, error: `App is busy: ${lock.holder} in progress` }, { status: 409, headers: corsHeaders });
    }
    try {
      const result = await rollbackApp(appId, body.deployment_id);
      return Response.json(result, { headers: corsHeaders });
    } finally {
      lock.release();
    }
  } catch (error) {
    return handleError(error);
  }
}
