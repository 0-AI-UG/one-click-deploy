import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { getContainerLogs } from "../../shared/remote/index.ts";
import { validateAppName, isValidMemoryMb, MIN_MEMORY_MB, MAX_MEMORY_MB, isValidCpuLimit, MIN_CPU_LIMIT, MAX_CPU_LIMIT, isPublicProtocol, isInternalProtocol, validateIngressFields } from "../../shared/validate.ts";
import { syncAppIngress, getPanelIngressIpv4 } from "../../engine/scale/traefik-manager.ts";
import { introspectRepo } from "../../shared/github-introspect.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enqueueOp } from "./_ops.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../../engine/scheduler.ts";

/** Enrich app row for API responses — adds environment name, the resolved
 *  public raw TCP/UDP address, a boolean `auth_enabled` flag, and strips every
 *  secret/credential field so nothing sensitive leaks to `servers.view` users.
 *  `auth_password_hash` is the source of truth for "auth on" but is itself a
 *  credential (bcrypt hash), so only the derived boolean goes out. */
export function enrichAppForResponse(app: AppRow & Record<string, unknown>) {
  const envRow = app.environment_id ? db.getEnvironment(app.environment_id as number) : null;
  const panelIp = app.public_port != null ? getPanelIngressIpv4() : null;
  const { auth_password_hash, webhook_secret, ...safe } = app;
  return {
    ...safe,
    env_vars: [],
    auth_enabled: !!auth_password_hash,
    environment_id: app.environment_id ?? null,
    environment_name: envRow?.name ?? null,
    public_address: app.public_port != null && panelIp ? `${panelIp}:${app.public_port}` : null,
  };
}

// One introspect endpoint for both deploy modes: `introspectRepo` detects an
// `ocd-stack.json` and returns a `kind: "stack"` result, else `kind: "app"`.
// The optional `path` param overrides which stack manifest to resolve.
export async function handleIntrospectRepo(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const params = new URL(request.url).searchParams;
    const url = params.get("url") || "";
    const ref = params.get("ref") || undefined;
    const path = params.get("path") || undefined;
    if (!url) {
      return Response.json(
        { ok: false, error: "Missing repo URL" },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = await introspectRepo(url, payload.userId, ref, path);
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
      apps: (s.apps || []).map((a: any) => enrichAppForResponse(a)),
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
      return enrichAppForResponse({ ...a, desired_replicas: a.desired_replicas ?? reps.length });
    });
    const services = db.getServices().map((svc) => {
      const instances = db.getServiceInstances(svc.id);
      const links = db.getServiceLinks(svc.id);
      return {
        ...svc,
        instance_count: instances.length,
        linked_environments: links.map((l) => ({ id: l.environment_id, name: l.environment_name })),
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
      return enrichAppForResponse({ ...a, host_port: first?.host_port ?? 0, servers });
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
    if (!req?.app_name || typeof req.app_name !== "string") {
      return Response.json({ ok: false, error: "app_name is required" }, { status: 400, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy",
      resourceKeys: [`app:create:${req.app_name}`],
      input: req,
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.destroy");
    await enforceConfirmation(request, payload, "delete_app", "app", String(appId));
    const { opId } = enqueue({ kind: "destroy_app", resourceKeys: [`app:${appId}`], input: { appId }, trigger: "ui", triggeredBy: payload.userId });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export function handleRestartApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.restart", kind: "restart_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handlePauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", kind: "pause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", kind: "unpause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export async function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.redeploy");
    const body = (await request.json().catch(() => ({}))) as {
      container_port?: number;
      environment_id?: number | null;
      public?: boolean;
      memory_mb?: number;
      cpu_limit?: number;
    };

    if (body.container_port !== undefined) {
      const p = Number(body.container_port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return Response.json({ ok: false, error: "Port must be an integer between 1 and 65535" }, { headers: corsHeaders });
      }
      body.container_port = p;
    }

    if (body.memory_mb !== undefined) {
      if (!isValidMemoryMb(body.memory_mb)) {
        return Response.json({ ok: false, error: `Memory must be an integer 0 (default) or ${MIN_MEMORY_MB}–${MAX_MEMORY_MB} MB` }, { headers: corsHeaders });
      }
      db.updateAppMemory(appId, body.memory_mb);
    }

    if (body.cpu_limit !== undefined) {
      if (!isValidCpuLimit(body.cpu_limit)) {
        return Response.json({ ok: false, error: `CPU must be 0 (default) or a number ${MIN_CPU_LIMIT}–${MAX_CPU_LIMIT} cores` }, { headers: corsHeaders });
      }
      db.updateAppCpu(appId, body.cpu_limit);
    }

    if (body.environment_id !== undefined) {
      db.updateAppEnvironment(appId, body.environment_id);
    }

    if (body.public !== undefined) {
      db.updateAppPublic(appId, body.public);
    }

    const { opId } = enqueue({
      kind: "redeploy",
      resourceKeys: [`app:${appId}`],
      input: {
        appId,
        container_port: body.container_port,
        userId: payload.userId,
      },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Update the per-app ingress settings (password protection, sticky sessions,
 * rate limit, IP allowlist, health-check path, compression, raw TCP/UDP
 * exposure). These only change rendered Traefik config — no container rebuild —
 * so this persists and re-syncs the ingress directly instead of enqueueing a
 * redeploy op. Password protection lives here too: under basicAuth a password
 * change is a pure ingress-config change (hash swap), never a rebuild.
 */
export async function handleUpdateIngressSettings(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.redeploy");
    const body = (await request.json().catch(() => ({}))) as {
      /** Write-only plaintext. Omit = leave auth unchanged; "" = disable auth;
       *  non-empty = enable/replace the password. Only the bcrypt hash is
       *  stored (apps.auth_password_hash). */
      auth_password?: string;
      sticky?: boolean;
      rate_limit_rps?: number;
      ip_allowlist?: string;
      health_check_path?: string;
      compress?: boolean;
      /** Post-deploy HTTP probe on/off; takes effect on the next (re)deploy/scale.
       *  L7-only — forced off below whenever routing is TCP. */
      health_check?: boolean;
      /** null = unexpose, "auto" = lowest free pool port, number = specific pool port. */
      public_port?: number | "auto" | null;
      public_protocol?: string;
      /** 'http' | 'tcp' — internal routing protocol. Omit = leave unchanged. */
      internal_protocol?: string;
    };

    const app = db.getApp(appId);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { status: 404, headers: corsHeaders });

    // Effective raw-exposure protocol: an explicit body value wins, else keep
    // the app's current pool. Fed to the shared validator so its range check
    // matches what we persist below.
    const effectivePublicProtocol = body.public_protocol !== undefined
      ? body.public_protocol
      : (app.public_protocol === "udp" ? "udp" : "tcp");

    // Effective internal routing protocol: explicit body value wins, else keep
    // the app's current one. Drives whether auth / health-check-path (HTTP
    // router features) are permitted.
    if (body.internal_protocol !== undefined && !isInternalProtocol(body.internal_protocol)) {
      return Response.json({ ok: false, error: 'Internal protocol must be "http" or "tcp"' }, { status: 400, headers: corsHeaders });
    }
    const effectiveInternalProtocol = isInternalProtocol(body.internal_protocol)
      ? body.internal_protocol
      : (app.internal_protocol === "tcp" ? "tcp" : "http");

    // One validator, shared with validateDeployRequest — auth/health-path/rate-
    // limit/allowlist/public-port rules and their error strings live in one place.
    const validation = validateIngressFields(
      {
        auth_password: body.auth_password,
        rate_limit_rps: body.rate_limit_rps,
        ip_allowlist: body.ip_allowlist,
        health_check_path: body.health_check_path,
        public_port: body.public_port,
        public_protocol: (body.public_port !== undefined || body.public_protocol !== undefined) ? effectivePublicProtocol : undefined,
      },
      { httpRouted: effectiveInternalProtocol === "http" },
    );
    if (!validation.valid) return Response.json({ ok: false, error: validation.error }, { status: 400, headers: corsHeaders });
    const norm = validation.value;

    // Serialize this direct ingress re-sync against engine operations on the
    // same app. A redeploy also re-renders this app's Traefik config, so the
    // two touching it concurrently could clobber each other. Hold the app lock
    // for the DB writes + sync; if an op already holds it, tell the caller to
    // retry (the UI also disables the button while an op is in flight).
    const acq = tryAcquire([`app:${appId}`], NON_OP_HOLDER, "ingress_sync");
    if (!acq.ok) {
      return Response.json(
        { ok: false, error: `App is busy with another operation (${acq.heldBy.kind}). Try again in a moment.` },
        { status: 409, headers: corsHeaders },
      );
    }
    try {
      const fields: Parameters<typeof db.updateAppIngressSettings>[1] = {};
      if (body.sticky !== undefined) fields.sticky = !!body.sticky;
      if (body.compress !== undefined) fields.compress = !!body.compress;
      if (norm.rate_limit_rps !== undefined) fields.rate_limit_rps = norm.rate_limit_rps;
      if (norm.ip_allowlist !== undefined) fields.ip_allowlist = norm.ip_allowlist;
      if (norm.health_check_path !== undefined) fields.health_check_path = norm.health_check_path;

      // Post-deploy HTTP probe. It's L7-only (a raw-TCP app can't answer it), so
      // force it off whenever routing is TCP — matching the deploy form's
      // protocol↔probe coupling — otherwise honor the explicit toggle. Unlike the
      // other fields this only bites on the next (re)deploy/scale, not the live
      // Traefik config.
      if (effectiveInternalProtocol === "tcp") {
        if (app.health_check) fields.health_check = false;
      } else if (body.health_check !== undefined) {
        fields.health_check = !!body.health_check;
      }

      // Password protection: write-only plaintext in, bcrypt hash stored. Empty
      // string clears the hash (disables auth); a non-empty value enables/replaces.
      if (norm.auth_password !== undefined) {
        db.updateAppAuthPassword(appId, norm.auth_password);
      }

      // Public raw TCP/UDP exposure. Deliberately independent of `public`
      // (HTTP publicness) — an HTTP-private app can still be TCP-exposed
      // (e.g. a database). Pure Traefik-config change like the rest of this
      // endpoint: expose/unexpose post-deploy, no rebuild. Range/protocol already
      // validated above; only DB allocation/freeness is checked here.
      if (body.public_port !== undefined) {
        const protocol: "tcp" | "udp" = isPublicProtocol(effectivePublicProtocol) ? effectivePublicProtocol : "tcp";
        if (body.public_port === null) {
          db.updateAppPublicExposure(appId, null, protocol);
        } else if (body.public_port === "auto") {
          // Idempotent: keep the current port unless the protocol changed.
          if (app.public_port == null || app.public_protocol !== protocol) {
            db.updateAppPublicExposure(appId, db.allocatePublicPort(protocol), protocol);
          }
        } else {
          const holder = db.getAppByPublicPort(body.public_port);
          if (holder && holder.id !== appId) {
            return Response.json({ ok: false, error: `Port ${body.public_port} is already used by "${holder.name}"` }, { status: 409, headers: corsHeaders });
          }
          db.updateAppPublicExposure(appId, body.public_port, protocol);
        }
      }

      // Internal routing protocol: persisted here (pure routing change). The
      // OCD_INTERNAL_URL scheme injected into the container only refreshes on the
      // app's next (re)deploy — the routing itself flips immediately below.
      if (isInternalProtocol(body.internal_protocol) && body.internal_protocol !== app.internal_protocol) {
        db.updateAppInternalProtocol(appId, body.internal_protocol);
      }

      db.updateAppIngressSettings(appId, fields);
      await syncAppIngress(appId);
      const updated = db.getApp(appId);
      return Response.json(
        { ok: true, public_port: updated?.public_port ?? null, public_protocol: updated?.public_protocol ?? "tcp" },
        { headers: corsHeaders },
      );
    } finally {
      release([`app:${appId}`]);
    }
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRenameApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
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

    const { opId } = enqueue({
      kind: "rename_app",
      resourceKeys: [`app:${appId}`],
      input: { appId, newName },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
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

    const logs = await getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined);

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

/**
 * POST /api/apps/promote — promote the exact version running in a SOURCE app
 * (e.g. `<name>-staging`) up to a DEST app (production). Validates both apps
 * exist, that they differ, and that the source has a successful deployment to
 * promote; then enqueues the promote op (which rebuilds `<dest>:latest` from the
 * source's git commit and swaps the DEST container(s)).
 */
export async function handlePromoteApp(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy");
    const body = (await request.json().catch(() => ({}))) as { source_app?: string; dest_app?: string };
    if (!body.source_app || !body.dest_app) {
      return Response.json({ error: "source_app and dest_app are required" }, { status: 400, headers: corsHeaders });
    }

    const source = db.getAppByName(body.source_app);
    if (!source) return Response.json({ error: `Source app not found: ${body.source_app}` }, { status: 404, headers: corsHeaders });
    const dest = db.getAppByName(body.dest_app);
    if (!dest) return Response.json({ error: `Destination app not found: ${body.dest_app}` }, { status: 404, headers: corsHeaders });

    if (source.id === dest.id) {
      return Response.json({ error: "Source and destination must be different apps" }, { status: 400, headers: corsHeaders });
    }

    const commit = db.getDeployments(source.id).find((d) => d.status === "deployed")?.git_commit;
    if (!commit) {
      return Response.json({ error: `Source app "${source.name}" has no successful deployment to promote` }, { status: 400, headers: corsHeaders });
    }

    // Different repos is unusual (promotions normally share a repo) but allowed;
    // surface it in the response so the caller can notice.
    const repo_mismatch = source.git_repo !== dest.git_repo;

    const { opId } = enqueue({
      kind: "promote",
      resourceKeys: [`app:${dest.id}`],
      input: { appId: dest.id, sourceAppId: source.id, userId: payload.userId },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId, commit, repo_mismatch }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.rollback");
    const body = await request.json() as { deployment_id: number };
    const { opId } = enqueue({
      kind: "rollback",
      resourceKeys: [`app:${appId}`],
      input: { appId, deploymentId: body.deployment_id },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
