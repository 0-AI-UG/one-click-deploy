import * as db from "../shared/db.ts";
import dbConn from "../shared/db/connection.ts";
import type { OperationRow, OperationStatus } from "../shared/db/operations.ts";

const APP_READY = new Set(["running", "sleeping", "paused"]);
const SERVICE_READY = new Set(["running", "paused"]);
const OP_TERMINAL = new Set<OperationStatus>([
  "done",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
]);
const HEALTH_STALE_AFTER_MS = 90_000;

export type ResourceAssessment = {
  safeToFinalizeDone: boolean;
  status: "done" | "failed";
  reason: string;
};

function inputOf(op: OperationRow): Record<string, any> {
  try {
    const parsed = JSON.parse(op.input_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function healthTimestampIsStale(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) && nowMs - timestamp > HEALTH_STALE_AFTER_MS;
}

/** Aggregate rows are intentionally not trusted alone: the reconciler updates
 * an instance first and propagates its parent status later in the same tick.
 * Status/readiness views must not report that gap as healthy. */
function memberInstanceIssues(
  apps: Array<NonNullable<ReturnType<typeof db.getApp>>>,
  services: Array<NonNullable<ReturnType<typeof db.getService>>>,
): string[] {
  const issues: string[] = [];
  for (const app of apps) {
    if (app.status === "paused" || app.status === "sleeping") continue;
    for (const replica of db.getReplicas(app.id)) {
      if (replica.status !== "running") {
        issues.push(`${app.name}/replica-${replica.id}:${replica.status}`);
      } else if (healthTimestampIsStale(replica.last_health_at)) {
        issues.push(`${app.name}/replica-${replica.id}:health-stale`);
      }
    }
  }
  for (const service of services) {
    if (service.status === "paused") continue;
    for (const instance of db.getServiceInstances(service.id)) {
      if (instance.status !== "running") {
        issues.push(`${service.name}/instance-${instance.id}:${instance.status}`);
      } else if (healthTimestampIsStale(instance.last_health_at)) {
        issues.push(`${service.name}/instance-${instance.id}:health-stale`);
      }
    }
  }
  return issues;
}

function assessApp(appId: number | undefined): ResourceAssessment {
  const app = appId ? db.getApp(appId) : null;
  const ready = !!app && APP_READY.has(app.status);
  return {
    safeToFinalizeDone: ready,
    status: ready ? "done" : "failed",
    reason: ready
      ? `app ${app!.name} is ${app!.status}`
      : app
        ? `app ${app.name} is ${app.status}`
        : "app no longer exists",
  };
}

function assessService(serviceId: number | undefined): ResourceAssessment {
  const service = serviceId ? db.getService(serviceId) : null;
  const ready = !!service && SERVICE_READY.has(service.status);
  return {
    safeToFinalizeDone: ready,
    status: ready ? "done" : "failed",
    reason: ready
      ? `service ${service!.name} is ${service!.status}`
      : service
        ? `service ${service.name} is ${service.status}`
        : "service no longer exists",
  };
}

function assessStack(op: OperationRow): ResourceAssessment {
  const input = inputOf(op);
  const stack = typeof input.name === "string"
    ? db.getStackByName(input.name)
    : Number.isFinite(Number(input.stackId))
      ? db.getStack(Number(input.stackId))
      : null;
  const name = stack?.name ?? (typeof input.name === "string" ? input.name : "");
  if (!stack) {
    return {
      safeToFinalizeDone: false,
      status: "failed",
      reason: name ? `stack ${name} no longer exists` : "stack name is unavailable",
    };
  }

  const expectedApps = Array.isArray(input.apps)
    ? input.apps.map((a: any) => `${name}-${String(a?.key ?? "")}`)
    : db.getAppsByStackId(stack.id).map((app) => app.name);
  const expectedServices = Array.isArray(input.services)
    ? input.services.map((s: any) => `${name}-${String(s?.key ?? "")}`)
    : db.getServicesByStackId(stack.id).map((service) => service.name);
  const apps = expectedApps.map((memberName) => db.getAppByName(memberName));
  const services = expectedServices.map((memberName) => db.getServiceByName(memberName));
  const missing = [
    ...expectedApps.filter((_n, i) => !apps[i]),
    ...expectedServices.filter((_n, i) => !services[i]),
  ];
  const unhealthy = [
    ...apps.filter((a) => a && !APP_READY.has(a.status)).map((a) => `${a!.name}:${a!.status}`),
    ...services.filter((s) => s && !SERVICE_READY.has(s.status)).map((s) => `${s!.name}:${s!.status}`),
    ...memberInstanceIssues(
      apps.filter((a): a is NonNullable<typeof a> => !!a),
      services.filter((s): s is NonNullable<typeof s> => !!s),
    ),
  ];
  const ready = missing.length === 0 && unhealthy.length === 0;
  return {
    safeToFinalizeDone: ready,
    status: ready ? "done" : "failed",
    reason: ready
      ? `all ${apps.length} app(s) and ${services.length} service(s) are healthy`
      : [
          missing.length ? `missing: ${missing.join(", ")}` : "",
          unhealthy.length ? `not ready: ${unhealthy.join(", ")}` : "",
        ].filter(Boolean).join("; "),
  };
}

/**
 * Derive whether an operation's intended resources already match a successful
 * terminal state. Used by `ops finalize` and by stale stack reconciliation.
 */
export function assessOperationResources(op: OperationRow): ResourceAssessment {
  const input = inputOf(op);
  switch (op.kind) {
    case "deploy_stack":
    case "promote_stack":
      return assessStack(op);
    case "destroy_stack": {
      const gone = !db.getStack(Number(input.stackId));
      return {
        safeToFinalizeDone: gone,
        status: gone ? "done" : "failed",
        reason: gone ? "stack is absent" : "stack still exists",
      };
    }
    case "deploy": {
      const app = typeof input.app_name === "string" ? db.getAppByName(input.app_name) : null;
      return assessApp(app?.id);
    }
    case "destroy_app": {
      const gone = !db.getApp(Number(input.appId));
      return {
        safeToFinalizeDone: gone,
        status: gone ? "done" : "failed",
        reason: gone ? "app is absent" : "app still exists",
      };
    }
    case "deploy_service": {
      const service = typeof input.name === "string" ? db.getServiceByName(input.name) : null;
      return assessService(service?.id);
    }
    case "destroy_service": {
      const gone = !db.getService(Number(input.serviceId));
      return {
        safeToFinalizeDone: gone,
        status: gone ? "done" : "failed",
        reason: gone ? "service is absent" : "service still exists",
      };
    }
    case "redeploy":
    case "restart_app":
    case "reload_app":
    case "rollback":
    case "promote":
    case "pause_app":
    case "unpause_app":
      return assessApp(Number(input.appId ?? input.destAppId));
    case "restart_service":
    case "pause_service":
    case "unpause_service":
      return assessService(Number(input.serviceId));
    default:
      return {
        safeToFinalizeDone: false,
        status: "failed",
        reason: `resource convergence is not defined for operation kind ${op.kind}`,
      };
  }
}

export function applyOperationResourceStatus(
  op: OperationRow,
  status: "done" | "failed",
): ResourceAssessment {
  const assessment = assessOperationResources(op);
  const input = inputOf(op);
  if (op.kind === "deploy_stack" || op.kind === "promote_stack") {
    const stack = typeof input.name === "string"
      ? db.getStackByName(input.name)
      : db.getStack(Number(input.stackId));
    if (stack) db.updateStackStatus(stack.id, status === "done" ? "running" : "failed");
  }
  return assessment;
}

export type StackResourceState = {
  status: "running" | "degraded" | "empty";
  reason: string;
  lastOperationId: number | null;
  lastOperationStatus: OperationStatus | null;
  lastOperationFailed: boolean;
  operationInProgress: boolean;
};

function operationHasStackKey(op: OperationRow, stackId: number, name: string): boolean {
  try {
    const keys = JSON.parse(op.resource_keys);
    return Array.isArray(keys) &&
      (keys.includes(`stack:${name}`) || keys.includes(`stack:${stackId}`));
  } catch {
    return false;
  }
}

/** Stack health is derived from current members. Operation outcome remains a
 * separate diagnostic signal and never overwrites a healthy reality. */
export function deriveStackResourceState(stack: db.StackRow): StackResourceState {
  const apps = db.getAppsByStackId(stack.id).filter((app) => app.target_of == null);
  const services = db.getServicesByStackId(stack.id);
  const unhealthy = [
    ...apps.filter((app) => !APP_READY.has(app.status)).map((app) => `${app.name}:${app.status}`),
    ...apps.filter((app) => app.public && app.public_endpoint_status === "degraded")
      .map((app) => `${app.name}:public-endpoint(${app.public_endpoint_error || "not ready"})`),
    ...services.filter((service) => !SERVICE_READY.has(service.status)).map((service) => `${service.name}:${service.status}`),
    ...memberInstanceIssues(apps, services),
  ];
  const rows = dbConn
    .query("SELECT * FROM operations ORDER BY id DESC")
    .all() as OperationRow[];
  const latest = rows.find((op) => operationHasStackKey(op, stack.id, stack.name)) ?? null;
  const empty = apps.length === 0 && services.length === 0;
  return {
    status: empty ? "empty" : unhealthy.length === 0 ? "running" : "degraded",
    reason: empty
      ? "stack has no materialized members"
      : unhealthy.length === 0
        ? `all ${apps.length} app(s) and ${services.length} service(s) are ready`
        : `not ready: ${unhealthy.join(", ")}`,
    lastOperationId: latest?.id ?? null,
    lastOperationStatus: latest?.status ?? null,
    lastOperationFailed: !!latest && ["failed", "compensated", "compensation_failed"].includes(latest.status),
    operationInProgress: !!latest && !OP_TERMINAL.has(latest.status),
  };
}

/**
 * A stack row is display state, not an operation lock. If no operation can
 * still change it, converge a stale `deploying` label from the actual members.
 */
export function reconcileStaleStackStates(): void {
  for (const stack of db.getStacks()) {
    const state = deriveStackResourceState(stack);
    const desired = state.status === "running" ? "running" : state.status;
    if (stack.status !== desired) db.updateStackStatus(stack.id, desired);
  }
}
