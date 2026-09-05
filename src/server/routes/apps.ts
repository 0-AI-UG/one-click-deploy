import { getAppStorage, appStorageView } from "../../shared/object-storage.ts";
import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin, requirePermission, requireCliPermission, requireAuthenticated, appScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { getContainerLogs } from "../../shared/remote/index.ts";
import { validateDeployRequest, validateBuildDeployRequest } from "../../shared/validate.ts";
import { syncAppIngress, getPanelIngressIpv4 } from "../../engine/scale/traefik-manager.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enqueueOp } from "./_ops.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { applyAppConfig, classifyConfigOnlyChanges, deployRequestFromApp, diffAppConfig } from "../../shared/app-config.ts";
import type { DeployRequest, ReleaseRequest } from "../../shared/rpc.ts";
import { findActiveOperationByResourceKey } from "../../shared/db/operations.ts";
import { approveAutomaticServerProvisioning } from "../lib/server-provisioning.ts";
import { stackLockKeys, withOwningStackKeys } from "../lib/stack-operations.ts";
import { reconcileAppDns } from "../../engine/dns-reconciler.ts";
import { resolveOciImage } from "../../engine/oci-image.ts";

/** Enrich app row for API responses — adds environment name, the resolved
 *  public raw TCP/UDP address, a boolean `auth_enabled` flag, and strips every
 *  secret/credential field so nothing sensitive leaks to `apps.view` users.
 *  `auth_password_hash` is the source of truth for "auth on" but is itself a
 *  credential (bcrypt hash), so only the derived boolean goes out. */
export function enrichAppForResponse(app: AppRow & Record<string, unknown>) {
  const envRow = app.environment_id ? db.getEnvironment(app.environment_id as number) : null;
  const panelIp = app.public_port != null ? getPanelIngressIpv4() : null;
  const { auth_password_hash, ...safe } = app;
  return {
    ...safe,
    env_vars: [],
    storage: getAppStorage(app.id),
    storage_bindings: appStorageView(app.id),
    auth_enabled: !!auth_password_hash,
    environment_id: app.environment_id ?? null,
    environment_name: envRow?.name ?? null,
    deployed_commit: db.getDeployedCommit(app.id),
    public_address: app.public_port != null && panelIp ? `${panelIp}:${app.public_port}` : null,
  };
}

async function withDnsInstruction<T extends { id: number }>(app: T): Promise<T & { dns_instruction: Awaited<ReturnType<typeof reconcileAppDns>> }> {
  return { ...app, dns_instruction: await reconcileAppDns(app.id, { skipIfBusy: true }) };
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const result = await Promise.all(getServersWithApps().map(async (s: any) => ({
      ...s,
      apps: await Promise.all((s.apps || []).map((a: any) => withDnsInstruction(enrichAppForResponse(a)))),
    })));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDashboard(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const compact = new URL(request.url).searchParams.get("compact") === "1";
    // Staging targets are shown through their production app's promotion view.
    const visibleApps = db.getApps().filter((a) => a.target_of == null);
    const apps = compact
      ? await Promise.all(visibleApps.map((app) => withDnsInstruction({
          id: app.id,
          name: app.name,
          status: app.status,
          domain: app.domain,
          public: app.public,
          container_port: app.container_port,
          internal_protocol: app.internal_protocol,
          deployed_commit: db.getDeployedCommit(app.id),
          environment_stale: app.environment_stale,
        })))
      : await Promise.all(visibleApps.map((app) => {
          const reps = db.getReplicas(app.id);
          return withDnsInstruction(enrichAppForResponse({ ...app, desired_replicas: app.desired_replicas ?? reps.length }));
        }));
    return Response.json({ apps }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetApps(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "apps.view");
    const apps = db.getApps();
    const result = await Promise.all(apps.map((a) => {
      const reps = db.getReplicas(a.id);
      const first = reps[0];
      const servers = db.getServersForApp(a.id).map((s) => s.id);
      return withDnsInstruction(enrichAppForResponse({ ...a, host_port: first?.host_port ?? 0, servers }));
    }));
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

type AppDeployRequest = Partial<DeployRequest> & {
  apply_mode?: "manifest";
  dry_run?: boolean;
  deploy?: boolean;
};

function manifestSpec(req: AppDeployRequest): DeployRequest {
  const {
    dry_run: _dryRun,
    deploy: _deploy,
    ...spec
  } = req;
  return spec as DeployRequest;
}

/**
 * The single existing-app manifest path. It owns validation, locking,
 * desired-state application, ingress sync, and optional rollout.
 */
async function applyExistingAppConfig(
  app: AppRow,
  spec: DeployRequest,
  controls: Pick<AppDeployRequest, "dry_run" | "deploy">,
  userId: string,
): Promise<Response> {
  const validation = validateDeployRequest(spec);
  if (!validation.valid) {
    return Response.json(
      { ok: false, error: validation.error },
      { status: 400, headers: corsHeaders },
    );
  }

  const changes = diffAppConfig(app, spec);
  if (controls.dry_run) {
    return Response.json({
      ok: true,
      dry_run: true,
      changes,
      current_config_revision: app.config_revision,
    }, { headers: corsHeaders });
  }

  const activeManifest = findActiveOperationByResourceKey("apply_manifest", `manifest:${app.id}`);
  if (activeManifest) {
    return Response.json(
      { ok: false, error: `Manifest operation #${activeManifest.id} is still active. Wait for it to finish before applying another manifest.` },
      { status: 409, headers: corsHeaders },
    );
  }

  if (controls.deploy !== false) {
    const owningStack = app.stack_id == null ? null : db.getStack(app.stack_id);
    const { opId } = enqueue({
      kind: "apply_manifest",
      resourceKeys: [`manifest:${app.id}`, ...(owningStack ? stackLockKeys(owningStack) : [])],
      input: { appId: app.id, userId, deploy: true, spec },
      trigger: "cli",
      triggeredBy: userId,
    });
    return Response.json({
      ok: true,
      applied: false,
      pending_commit: true,
      changes,
      config_revision: changes.length > 0 ? app.config_revision + 1 : app.config_revision,
      op_id: opId,
    }, { headers: corsHeaders });
  }

  const owningStack = app.stack_id == null ? null : db.getStack(app.stack_id);
  const plan = classifyConfigOnlyChanges(changes, {
    // Manifest env entries may update encrypted values that are deliberately
    // absent from the public config diff. Recreate conservatively so the
    // reported runtime state is truthful.
    environmentChanged: Array.isArray(spec.env_vars) && spec.env_vars.length > 0,
  });
  // Preserve the established config-only API contract: desired state is
  // durably applied before the response. The child operation below performs
  // only the required runtime/volume reconciliation.
  await applyAppConfig(app.id, spec, {
    userId,
    log: (line) => db.appendDeployLog(app.id, `[config] ${line}`),
  });
  await syncAppIngress(app.id);
  const updated = db.getApp(app.id)!;
  if (plan.pendingRollout) db.requestAppRollout(app.id, updated.config_revision);
  const { opId } = enqueue({
    kind: "apply_manifest",
    resourceKeys: [`manifest:${app.id}`, ...(owningStack ? stackLockKeys(owningStack) : [])],
    input: {
      appId: app.id,
      userId,
      deploy: false,
      rollout: plan.rollout,
      pendingRollout: plan.pendingRollout,
    },
    trigger: "cli",
    triggeredBy: userId,
  });
  return Response.json({
    ok: true,
    applied: true,
    changes,
    rollout: plan.rollout,
    pending_rollout: plan.pendingRollout,
    config_revision: updated.config_revision,
    op_id: opId,
  }, { headers: corsHeaders });
}

/** Re-run an app from its stored immutable artifact and desired configuration. */
export async function handleRedeployApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.deploy", appScope(appId));
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    const { opId } = enqueue(withOwningStackKeys({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id, userId: payload.userId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    }));
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** Publish one externally-built immutable artifact as the app's desired and
 * running release. Configuration is reconstructed from persisted desired
 * state and committed only after the candidate passes health checks. */
export async function handleReleaseApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requireCliPermission(request, "apps.deploy", appScope(appId));
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    const body = await request.json() as ReleaseRequest;
    const image = typeof body?.image === "string" ? body.image.trim() : "";
    const commit = typeof body?.commit === "string" ? body.commit.trim() : undefined;
    const candidate = { ...deployRequestFromApp(app), image_ref: image };
    // Migration 97 deliberately represents pre-manifest volume attachments
    // with desired_volume_size=-1: OCD knows the attachment is real but does
    // not guess its provider size.  A release changes only the image, so
    // validate the rest of the stored configuration as volume-neutral while
    // retaining the sentinel in the candidate passed to the operation.
    const validationCandidate = app.desired_volume_size < 0
      ? { ...candidate, volume_id: "", volume_size: 0 }
      : candidate;
    const validation = validateDeployRequest({ ...validationCandidate, git_commit: commit });
    if (!validation.valid) {
      return Response.json({ error: validation.error }, { status: 400, headers: corsHeaders });
    }
    const requestedKey = request.headers.get("Idempotency-Key")?.trim();
    if (requestedKey && (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestedKey))) {
      return Response.json(
        { error: "Idempotency-Key must be 1-200 characters using letters, digits, '.', '_', ':', or '-'" },
        { status: 400, headers: corsHeaders },
      );
    }
    const { opId } = enqueue(withOwningStackKeys({
      kind: "redeploy",
      resourceKeys: [`app:${app.id}`],
      input: {
        appId: app.id,
        userId: payload.userId,
        gitCommit: commit,
        candidate,
        allowUnchangedLegacyVolumeIntent: app.desired_volume_size < 0,
      },
      trigger: "release",
      triggeredBy: payload.userId,
      idempotencyKey: requestedKey ? `release:${app.id}:${requestedKey}` : undefined,
    }));
    return Response.json({ op_id: opId, image, commit: commit ?? null }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeploy(request: Request): Promise<Response> {
  try {
    const payload = await requireCliPermission(request, "apps.deploy");
    const req = await request.json() as AppDeployRequest;
    if (req.storage && Object.keys(req.storage).length) await requireAdmin(request);
    if (!req?.app_name || typeof req.app_name !== "string") {
      return Response.json({ ok: false, error: "app_name is required" }, { status: 400, headers: corsHeaders });
    }
    if (req.apply_mode !== "manifest") {
      return Response.json(
        { ok: false, error: 'apply_mode must be "manifest"' },
        { status: 400, headers: corsHeaders },
      );
    }
    if (req.volume_size === undefined) {
      return Response.json(
        { ok: false, error: "Manifest must declare explicit primary volume state (`volume: null` or a volume object)" },
        { status: 400, headers: corsHeaders },
      );
    }
    if (Boolean(req.build) === Boolean(req.image_ref)) {
      return Response.json(
        { ok: false, error: "Exactly one delivery source is required: build or image_ref" },
        { status: 400, headers: corsHeaders },
      );
    }
    req.delivery_source = req.build ? "build" : "image";

    const existing = db.getAppByName(req.app_name);
    if (!req.build && req.image_ref) {
      if (req.deploy === false && existing) {
        // Config-only reconciles manifest settings while deliberately retaining
        // the deployed immutable artifact.
        req.image_ref = existing.image_ref;
      } else {
        req.image_ref = await resolveOciImage(req.image_ref);
      }
    }
    if (req.build && !req.image_ref && req.deploy !== false) {
      const buildRequest = manifestSpec(req);
      const validation = validateBuildDeployRequest(buildRequest);
      if (!validation.valid) {
        return Response.json({ ok: false, error: validation.error }, { status: 400, headers: corsHeaders });
      }
      if (req.dry_run) {
        const build = buildRequest.build!;
        const changes = existing
          ? diffAppConfig(existing, { ...buildRequest, image_ref: existing.image_ref })
          : [];
        return Response.json({
          ok: true,
          dry_run: true,
          would_create: !existing,
          changes,
          build: {
            repository: build.repository,
            commit: buildRequest.git_commit,
            image_repository: build.image_repository,
          },
        }, { headers: corsHeaders });
      }
      if (!existing && !buildRequest.server_id) {
        await approveAutomaticServerProvisioning(
          request,
          payload,
          `building and deploying app ${buildRequest.app_name}`,
          [buildRequest.placement_pool || "general"],
        );
        buildRequest.server_provisioning_approved = true;
      }
      const { opId } = enqueue({
        kind: "build_app_delivery",
        resourceKeys: [`build:${buildRequest.build!.repository}#${buildRequest.build!.branch || "main"}`, `app-delivery:${req.app_name}`],
        input: { spec: buildRequest, userId: payload.userId },
        trigger: "cli",
        triggeredBy: payload.userId,
      });
      return Response.json({ ok: true, op_id: opId, changes: [] }, { status: 202, headers: corsHeaders });
    }
    if (existing) {
      const spec = manifestSpec(req);
      if (req.deploy === false && spec.build && !spec.image_ref) {
        spec.image_ref = existing.image_ref;
        spec.build = undefined;
      }
      return applyExistingAppConfig(
        existing,
        spec,
        req,
        payload.userId,
      );
    }
    const deployRequest = manifestSpec(req);
    // Never trust this internal flag from the request body. New app deployment
    // may select existing capacity, but any provider creation it falls back to
    // must have been approved for this exact deployment first.
    deployRequest.server_provisioning_approved = false;
    const validation = validateDeployRequest(deployRequest);
    if (!validation.valid) {
      return Response.json(
        { ok: false, error: validation.error },
        { status: 400, headers: corsHeaders },
      );
    }
    if (req.dry_run) {
      return Response.json(
        { ok: true, dry_run: true, would_create: true, changes: [] },
        { headers: corsHeaders },
      );
    }
    if (req.deploy === false) {
      return Response.json(
        { ok: false, error: `Cannot apply configuration only: app "${req.app_name}" does not exist` },
        { status: 404, headers: corsHeaders },
      );
    }
    if (!deployRequest.server_id) {
      await approveAutomaticServerProvisioning(
        request,
        payload,
        `deploying app ${deployRequest.app_name}`,
        [deployRequest.placement_pool || "general"],
      );
      deployRequest.server_provisioning_approved = true;
    }
    const { opId } = enqueue({
      kind: "deploy",
      resourceKeys: [`app:create:${req.app_name}`],
      input: deployRequest,
      trigger: "cli",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDestroyApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.destroy", appScope(appId));
    await enforceConfirmation(request, payload, "delete_app", "app", String(appId));
    const volumeId = db.getApp(appId)?.volume_id;
    const { opId } = enqueue({
      kind: "destroy_app",
      resourceKeys: [`app:${appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])],
      input: { appId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export function handleRestartApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.restart", scope: appScope(appId), kind: "restart_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export async function handleReloadAppEnvironment(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.restart", appScope(appId));
    const body = await request.clone().json().catch(() => ({})) as { force?: boolean };
    if (body.force !== true) {
      return Response.json(
        { error: "Environment reload is explicit and disruptive; force=true is required" },
        { status: 400, headers: corsHeaders },
      );
    }
    return enqueueOp(request, {
      permission: "apps.restart",
      scope: appScope(appId),
      kind: "reload_app",
      resourceKeys: [`app:${appId}`],
      input: { appId, force: true },
    });
  } catch (error) {
    return handleError(error);
  }
}

export function handlePauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", scope: appScope(appId), kind: "pause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export function handleUnpauseApp(request: Request, appId: number): Promise<Response> {
  return enqueueOp(request, { permission: "apps.pause", scope: appScope(appId), kind: "unpause_app", resourceKeys: [`app:${appId}`], input: { appId } });
}

export async function handleGetContainerLogs(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.logs", appScope(appId));
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
    await requirePermission(request, "deployments.view", appScope(appId));
    const log = db.getDeployLog(appId);
    return Response.json({ log }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetDeployments(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "deployments.view", appScope(appId));
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
 * promote; then enqueues the promote op, which pulls and runs the exact source
 * artifact digest on the destination.
 */
export async function handlePromoteApp(request: Request): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const body = (await request.json().catch(() => ({}))) as { source_app?: string; dest_app?: string };
    if (!body.source_app || !body.dest_app) {
      return Response.json({ error: "source_app and dest_app are required" }, { status: 400, headers: corsHeaders });
    }

    const source = db.getAppByName(body.source_app);
    if (!source) return Response.json({ error: `Source app not found: ${body.source_app}` }, { status: 404, headers: corsHeaders });
    const dest = db.getAppByName(body.dest_app);
    if (!dest) return Response.json({ error: `Destination app not found: ${body.dest_app}` }, { status: 404, headers: corsHeaders });

    // The promote op acts on the destination app, so that's the app the permission is scoped against. The body
    // has to be read first to know which app that is.
    await requirePermission(request, "apps.promote", appScope(dest.id));

    if (source.id === dest.id) {
      return Response.json({ error: "Source and destination must be different apps" }, { status: 400, headers: corsHeaders });
    }

    const sourceDeployment = db.getDeployments(source.id).find((d) => d.status === "deployed");
    if (!sourceDeployment?.image_digest?.includes("@sha256:")) {
      return Response.json({ error: `Source app "${source.name}" has no successful deployment to promote` }, { status: 400, headers: corsHeaders });
    }
    await enforceConfirmation(
      request,
      payload,
      "promote_app",
      "promotion",
      `${source.id}:${dest.id}`,
    );

    const { opId } = enqueue({
      kind: "promote",
      resourceKeys: [`app:${dest.id}`],
      input: { appId: dest.id, sourceAppId: source.id, userId: payload.userId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId, image: sourceDeployment.image_digest, commit: sourceDeployment.git_commit || null }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** The git commit of an app's most recent successful deployment, or null. */
function deployedCommit(appId: number): string | null {
  return db.getDeployments(appId).find((d) => d.status === "deployed")?.git_commit ?? null;
}

/**
 * GET /api/apps/:id/staging — explicit artifact staging target status.
 */
export async function handleGetAppStaging(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.view", appScope(appId));
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const siblingRow = db.getStagingSibling(appId);
    const sibling = siblingRow
      ? {
          id: siblingRow.id,
          name: siblingRow.name,
          status: siblingRow.status,
          domain: siblingRow.domain,
          commit: deployedCommit(siblingRow.id),
        }
      : null;

    return Response.json(
      {
        staging_enabled: siblingRow != null,
        staging_environment_id: siblingRow?.environment_id ?? null,
        prod_commit: deployedCommit(app.id),
        sibling,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRollbackApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "apps.rollback", appScope(appId));
    const body = await request.json() as { deployment_id: number };
    const { opId } = enqueue({
      kind: "rollback",
      resourceKeys: [`app:${appId}`],
      input: { appId, deploymentId: body.deployment_id },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
