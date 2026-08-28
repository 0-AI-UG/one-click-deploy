import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireCliPermission, appScope, stackScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { findActiveOperationByResourceKey, listChildOperations } from "../../shared/db/operations.ts";
import { getContainerLogs, sshExec } from "../../shared/remote/index.ts";
import { deriveStackResourceState } from "../../engine/resource-state.ts";
import { findLatestRelatedStackOperation, stackLockKeys } from "../lib/stack-operations.ts";
import { validatePublicEndpoint } from "../../engine/dns-reconciler.ts";
import { approveAutomaticServerProvisioning } from "../lib/server-provisioning.ts";
import { enrichAppForResponse } from "./apps.ts";

const TERMINAL_OPERATION_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
]);

function operationFields(stack: db.StackRow, fallback: ReturnType<typeof deriveStackResourceState>) {
  const latest = findLatestRelatedStackOperation(stack);
  if (!latest) {
    return {
      last_operation_id: fallback.lastOperationId,
      last_operation_status: fallback.lastOperationStatus,
      last_operation_failed: fallback.lastOperationFailed,
      operation_in_progress: fallback.operationInProgress,
      last_operation_children: [],
    };
  }
  return {
    last_operation_id: latest.id,
    last_operation_status: latest.status,
    last_operation_failed: ["failed", "compensated", "compensation_failed"].includes(latest.status),
    operation_in_progress: !TERMINAL_OPERATION_STATUSES.has(latest.status),
    last_operation_children: listChildOperations(latest.id).map((child) => ({
      id: child.id,
      kind: child.kind,
      status: child.status,
    })),
  };
}

// --- Deploy ---

export async function handleDeployStack(request: Request): Promise<Response> {
  try {
    const payload = await requireCliPermission(request, "stacks.deploy");
    const req: StackDeployRequest = await request.json();
    if (!req?.name || typeof req.name !== "string") {
      return Response.json({ ok: false, error: "name is required" }, { status: 400, headers: corsHeaders });
    }
    req.server_provisioning_approved = false;
    // Single-flight: only one deploy_stack per stack may run at a time. If one is
    // already in flight (pending/running/compensating), attach to it — follow the
    // existing run — instead of enqueuing a duplicate.
    const resourceKey = `stack:${req.name}`;
    const existing = findActiveOperationByResourceKey("deploy_stack", resourceKey);
    if (existing) {
      return Response.json({ op_id: existing.id, attached: true }, { headers: corsHeaders });
    }
    const stack = db.getStackByName(req.name);
    const selectedApps = req.selected_app_keys
      ? req.apps.filter((app) => req.selected_app_keys!.includes(app.key))
      : req.apps;
    const selectedServices = req.selected_service_keys
      ? req.services.filter((service) => req.selected_service_keys!.includes(service.key))
      : req.services;
    const hasNewServices = selectedServices.some((service) => !db.getServiceByName(`${req.name}-${service.key}`));
    const wantsStagingServices = false;
    const hasNewStagingServices = wantsStagingServices && selectedServices.some(
      (service) => !db.getServiceByName(`${req.name}-${service.key}-staging`),
    );
    const newApps = selectedApps.filter((app) => !db.getAppByName(`${req.name}-${app.key}`));
    if (hasNewServices || hasNewStagingServices || newApps.length > 0) {
      const pools = [
        ...(hasNewServices ? ["general"] : []),
        ...(hasNewStagingServices ? ["staging"] : []),
        ...newApps.map((app) => app.placement_pool || "general"),
      ];
      await approveAutomaticServerProvisioning(request, payload, `deploying stack ${req.name}`, pools);
      req.server_provisioning_approved = true;
    }
    const selectedBuildApps = selectedApps.filter((app) => !!app.build && !app.image_ref);
    if (!req.config_only && selectedBuildApps.length > 0) {
      if (selectedBuildApps.length !== selectedApps.length) {
        return Response.json(
          { error: "Selected stack members must use one delivery mode; OCD build manifests cannot be mixed with image overrides" },
          { status: 400, headers: corsHeaders },
        );
      }
      const { opId } = enqueue({
        kind: "build_stack_delivery",
        resourceKeys: [`build-stack:${req.name}`],
        input: { spec: req, userId: payload.userId },
        trigger: "cli",
        triggeredBy: payload.userId,
      });
      return Response.json({ op_id: opId }, { status: 202, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy_stack",
      resourceKeys: stack ? stackLockKeys(stack) : [`stack:${req.name}`],
      input: req,
      trigger: "cli",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetStacks(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    const stacks = db.getStacks();
    const result = stacks.map((s) => {
      const apps = db.getAppsByStackId(s.id);
      const resourceState = deriveStackResourceState(s);
      return {
        ...s,
        status: resourceState.status,
        resource_status_reason: resourceState.reason,
        ...operationFields(s, resourceState),
        app_count: apps.length,
        service_count: db.getServicesByStackId(s.id).length,
        // How many members `promote_stack` would actually promote. This applies
        // the same artifact-target rule as planPromotions so the dashboard button and the
        // CLI pre-check can't offer a promote the op then rejects.
        staging_sibling_count: apps.filter((a) => {
          if (a.target_of != null) return false;
          const sibling = db.getStagingSibling(a.id);
          return sibling != null && db.getLastSuccessfulDeployment(sibling.id)?.image_digest?.includes("@sha256:") === true;
        }).length,
      };
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Detail ---

export async function handleGetStack(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view", stackScope(stackId));
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const resourceState = deriveStackResourceState(stack);
    const apps = db.getAppsByStackId(stackId);
    const validateEndpoints = new URL(request.url).searchParams.get("validate_endpoints") === "1";
    const publicEndpoints = validateEndpoints
      ? await Promise.all(apps.filter((app) => app.public && app.domain).map(async (app) => {
          try {
            return {
              app_id: app.id,
              app_name: app.name,
              ...(await validatePublicEndpoint(app.id)),
            };
          } catch (err) {
            const current = db.getApp(app.id);
            return {
              app_id: app.id,
              app_name: app.name,
              domain: app.domain,
              managed: false,
              expectedTarget: "",
              resolved: [] as string[],
              ready: false,
              tlsReady: false,
              tlsError: current?.public_endpoint_error || (err instanceof Error ? err.message : String(err)),
            };
          }
        }))
      : [];
    const endpointDegraded = publicEndpoints.some((endpoint) => !endpoint.ready || !endpoint.tlsReady);
    let acme_errors: string[] = [];
    if (validateEndpoints && endpointDegraded) {
      const panel = db.getPanel();
      const server = panel ? db.getServer(panel.server_id) : null;
      if (server) {
        const logs = await sshExec(
          server.ipv4,
          "journalctl -u ocd-traefik -n 250 --no-pager 2>/dev/null | grep -iE 'acme|certificate|challenge' | tail -20 || true",
          server.ssh_host_key || undefined,
        ).catch(() => null);
        acme_errors = logs?.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
      }
    }
    return Response.json({
      ...stack,
      status: endpointDegraded && resourceState.status === "running" ? "degraded" : resourceState.status,
      resource_status_reason: endpointDegraded
        ? `${resourceState.reason}; one or more public endpoints are not HTTPS-ready`
        : resourceState.reason,
      ...operationFields(stack, resourceState),
      apps: apps.map((app) => enrichAppForResponse(app as db.AppRow & Record<string, unknown>)),
      services: db.getServicesByStackId(stackId),
      public_endpoints: publicEndpoints,
      acme_errors,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Log ---

export async function handleGetStackLog(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view", stackScope(stackId));
    return Response.json({ log: db.getStackLog(stackId) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/stacks/:id/member-logs?tail=N — container logs of every member, in
 * one round trip.
 *
 * A stack is only interesting as a whole: a request crosses three of its apps
 * and a database, so reading one member's log at a time is the wrong unit. We
 * fan out over the members' primary replica / instance, ask docker for
 * timestamped lines, and hand the client one block per member. Interleaving and
 * per-member filtering happen client-side so toggling a member off is instant
 * and doesn't re-run N ssh calls.
 *
 * Gated on `apps.logs` on top of `stacks.view`: this returns container output,
 * which is strictly more than the stack metadata `stacks.view` covers. Because
 * the response is already a per-member list that tolerates missing blocks, the
 * `apps.logs` check is applied per member and members the caller may not read
 * are simply omitted, rather than failing the whole request.
 */
export async function handleGetStackMemberLogs(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.view", stackScope(stackId));
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const tail = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("tail") || "100", 10) || 100, 1), 1000);

    // Staging siblings follow their production app and are not members in their
    // own right — the same rule the detail page's member list uses.
    //
    // Container output is gated per member: `apps.logs` scoped to each member app,
    // `services.logs` for the service members. A member the caller may not read is
    // dropped from the response instead of 403-ing the request, so a user with a
    // narrow grant still sees the members they were given.
    const apps = db
      .getAppsByStackId(stackId)
      .filter((a) => a.target_of == null)
      .filter((a) => db.hasPermission(payload.userId, "apps.logs", appScope(a.id)));
    const services = db.hasPermission(payload.userId, "services.logs")
      ? db.getServicesByStackId(stackId)
      : [];

    const fetchApp = async (app: { id: number; name: string }) => {
      const replicas = db.getReplicas(app.id);
      if (replicas.length === 0) throw new Error("No replicas");
      const replica = replicas[0];
      const server = db.getServer(replica.server_id);
      if (!server) throw new Error("Server not found");
      return getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined, true);
    };

    const fetchService = async (service: { id: number; name: string }) => {
      const instance = db.getPrimaryInstance(service.id);
      if (!instance) throw new Error("No primary instance");
      const server = db.getServer(instance.server_id);
      if (!server) throw new Error("Server not found");
      return getContainerLogs(server.ipv4, instance.container_name, tail, server.ssh_host_key || undefined, true);
    };

    // One slow or unreachable member must not blank the whole view, so each
    // failure is reported in its own block and the rest still render.
    const members = await Promise.all([
      ...apps.map(async (a) => {
        try {
          return { kind: "app" as const, id: a.id, name: a.name, logs: await fetchApp(a) };
        } catch (err) {
          return { kind: "app" as const, id: a.id, name: a.name, logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      }),
      ...services.map(async (s) => {
        try {
          return { kind: "service" as const, id: s.id, name: s.name, logs: await fetchService(s) };
        } catch (err) {
          return { kind: "service" as const, id: s.id, name: s.name, logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ]);

    return Response.json({ members }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.destroy", stackScope(stackId));
    await enforceConfirmation(request, payload, "delete_stack", "stack", String(stackId));
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "destroy_stack",
      resourceKeys: stackLockKeys(stack),
      input: { stackId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// Promote every stack member that has an explicit staging sibling holding a
// deployed artifact. Fans out to the per-app `promote` op; member selection (and
// the "nothing to promote" error) lives in the promote_stack op itself so the
// CLI and the UI get identical behaviour.
export async function handlePromoteStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.promote", stackScope(stackId));
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "promote_stack", "stack", String(stackId));
    const { opId } = enqueue({
      kind: "promote_stack",
      // Both key shapes on purpose: `stack:<id>` serializes against
      // destroy_stack, `stack:<name>` against deploy_stack (which keys on the
      // name). Without the name key a concurrent stack deploy would enqueue a
      // `redeploy` on the same member as our `promote`, and if the redeploy
      // landed last production would no longer match the promoted artifact.
      resourceKeys: stackLockKeys(stack),
      input: { stackId, userId: payload.userId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
