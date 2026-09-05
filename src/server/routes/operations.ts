import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { requirePermission } from "../lib/permissions.ts";
import { getUserById } from "../../shared/db.ts";
import { PermissionError } from "../lib/errors.ts";
import {
  getOperation,
  getSteps,
  listPendingOperations,
  listRunningOperations,
  listRecentOperations,
  listChildOperations,
  requestCancel,
  requeueOperation,
  retryOperationAsNew,
  retryWebhookOperationAsNew,
  finalizeOperation,
} from "../../shared/db/operations.ts";
import { getSettings } from "../../shared/db/settings.ts";
import { getApp } from "../../shared/db/apps.ts";
import { getServer } from "../../shared/db/servers.ts";
import { stepCount, listOps, getOp } from "../../engine/ops/registry.ts";
import { getFilteredOpLogs } from "../../engine/op-logger.ts";
import { currentHolder } from "../../engine/scheduler.ts";
import {
  applyOperationResourceStatus,
  assessOperationResources,
} from "../../engine/resource-state.ts";
import { previewCompensation } from "../../engine/compensation-safety.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";

// Keys whose values may contain secrets (connection strings, passwords,
// tokens, credentials, and env-var values). Redacted in any op input/output
// JSON returned to API clients.
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|credential|connection_url|auth_password|api_key|access_key|private_key|env_vars?|env_overrides|^env$|^outputs$|flatEnvVars)/i;

const REDACTED = "[redacted]";

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function labelForResourceKey(key: string): string {
  const m = /^(app|server):(\d+)$/.exec(key);
  if (!m) return key;
  const id = parseInt(m[2], 10);
  if (m[1] === "app") {
    const app = getApp(id);
    return app ? app.name : key;
  }
  const server = getServer(id);
  return server ? server.name : key;
}

function toJsonRow(op: ReturnType<typeof getOperation> & {}) {
  const resourceKeys: string[] = safeParse(op.resource_keys, []);
  const resourceLabels = resourceKeys.map(labelForResourceKey);
  const input = redact(safeParse(op.input_json, {}));
  const error = op.error_json ? safeParse(op.error_json, null) : null;
  const cancelRequested = Boolean((error as { cancel_requested?: unknown } | null)?.cancel_requested);
  return {
    id: op.id,
    kind: op.kind,
    label: getOp(op.kind)?.label ?? op.kind,
    resource_keys: resourceKeys,
    resource_labels: resourceLabels,
    input,
    status: op.status,
    cancel_requested: cancelRequested,
    parent_id: op.parent_id,
    attempt: op.attempt,
    scheduled_for: op.scheduled_for,
    last_step: op.last_step,
    trigger: op.trigger,
    triggered_by: op.triggered_by,
    enqueued_at: op.enqueued_at,
    started_at: op.started_at,
    finished_at: op.finished_at,
    error,
    total_steps: stepCount(op.kind),
  };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapStep(s: ReturnType<typeof getSteps>[number]) {
  return {
    seq: s.seq,
    step: s.step,
    phase: s.phase,
    status: s.status,
    detail: s.detail,
    output: s.output_json ? redact(safeParse(s.output_json, null)) : null,
    started_at: s.started_at,
    finished_at: s.finished_at,
  };
}

export async function handleListOperations(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "operations.view");
    const running = listRunningOperations().map(toJsonRow);
    const pending = listPendingOperations(100).map(toJsonRow);
    const recent = listRecentOperations(50).map(toJsonRow);
    const heartbeatRaw = getSettings().engine_heartbeat || null;
    return Response.json(
      {
        running,
        pending,
        recent,
        engine: {
          heartbeat: heartbeatRaw,
          concurrency: parseInt(process.env.ENGINE_CONCURRENCY || "4", 10),
          known_kinds: listOps().map((k) => ({ kind: k.kind, label: k.label, steps: k.steps.length })),
        },
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleGetOperation(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "operations.view");
    const op = getOperation(id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    const steps = getSteps(id, 0).map(mapStep);
    const children = listChildOperations(id).map(toJsonRow);
    const outstandingChildren = children.filter((child) =>
      !["done", "failed", "cancelled", "compensated", "compensation_failed"].includes(child.status)
    );
    return Response.json(
      {
        ...toJsonRow(op),
        steps,
        children,
        outstanding_children: outstandingChildren,
        cancellation_phase: op.error_json && safeParse<{ cancel_requested?: unknown }>(op.error_json, {}).cancel_requested
          ? (outstandingChildren.length > 0 ? "waiting_for_children" : "requested")
          : null,
        compensation_preview: previewCompensation(op),
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleOperationEvents(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "operations.view");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const timeoutMs = Math.min(parseInt(url.searchParams.get("wait") || "15000", 10), 25000);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const op = getOperation(id);
      if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
      const terminal = ["done", "failed", "cancelled", "compensated", "compensation_failed"].includes(op.status);
      // Step rows mutate in place at the same seq (started → ok), so an
      // exclusive `since` cursor misses the final transition of the last
      // step(s). On terminal, re-send the full list so the client lands on
      // every step's final state instead of a frozen "started".
      const steps = terminal ? getSteps(id, 0) : getSteps(id, since);
      if (steps.length > 0 || terminal) {
        const nextCursor = steps.reduce((max, step) => Math.max(max, step.seq), since);
        const children = listChildOperations(id).map(toJsonRow);
        const latestLog = getFilteredOpLogs(id, { limit: 1, tail: true })[0] ?? null;
        return Response.json(
          {
            status: op.status,
            last_step: op.last_step,
            started_at: op.started_at || op.enqueued_at,
            error: op.error_json ? safeParse(op.error_json, null) : null,
            steps: steps.map(mapStep),
            next_cursor: nextCursor,
            resumable: true,
            children,
            latest_log: latestLog,
          },
          { headers: corsHeaders },
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    // Timed out with no new events — client re-polls.
    const op = getOperation(id)!;
    const children = listChildOperations(id).map(toJsonRow);
    const latestLog = getFilteredOpLogs(id, { limit: 1, tail: true })[0] ?? null;
    return Response.json(
      {
        status: op.status, last_step: op.last_step, started_at: op.started_at || op.enqueued_at,
        steps: [], next_cursor: since, resumable: true, children, latest_log: latestLog,
      },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleGetOperationLogs(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "operations.view");
    const op = getOperation(id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const tail = Math.min(Math.max(parseInt(url.searchParams.get("tail") || "0", 10) || 0, 0), 5000);
    const sinceTimeRaw = url.searchParams.get("since_time") || "";
    const sinceTime = sinceTimeRaw && Number.isFinite(Date.parse(sinceTimeRaw))
      ? new Date(sinceTimeRaw).toISOString().replace("T", " ").slice(0, 19)
      : "";
    if (sinceTimeRaw && !sinceTime) {
      return Response.json({ error: "since_time must be an ISO timestamp" }, { status: 400, headers: corsHeaders });
    }
    const phase = url.searchParams.get("phase") || "";
    if (phase && !/^[a-zA-Z0-9_-]{1,80}$/.test(phase)) {
      return Response.json({ error: "phase must be a step name, forward, or compensate" }, { status: 400, headers: corsHeaders });
    }
    const child = url.searchParams.get("child") || "";
    let target = op;
    if (child) {
      const children = [] as ReturnType<typeof listChildOperations>;
      const queue = [id];
      const seen = new Set<number>();
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        for (const descendant of listChildOperations(parentId)) {
          children.push(descendant);
          queue.push(descendant.id);
        }
      }
      const matchingChild = children.find((candidate) => String(candidate.id) === child) ??
        children.find((candidate) => {
          const row = toJsonRow(candidate);
          const needle = child.toLowerCase();
          return row.resource_labels.some((label) => label.toLowerCase() === needle) ||
            row.resource_keys.some((key) => key.toLowerCase() === needle);
        });
      if (!matchingChild) {
        return Response.json({ error: `Operation #${id} has no child matching ${child}` }, { status: 404, headers: corsHeaders });
      }
      target = matchingChild;
    }
    const wait = parseInt(url.searchParams.get("wait") || "0", 10);
    const timeoutMs = Math.min(Math.max(wait, 0), 25000);
    const readLogs = () => getFilteredOpLogs(target!.id, {
      sinceId: since,
      sinceTime,
      phase,
      limit: tail || 1000,
      tail: tail > 0,
    });

    if (timeoutMs > 0) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const logs = readLogs();
        const cur = getOperation(target.id)!;
        const terminal = ["done", "failed", "cancelled", "compensated", "compensation_failed"].includes(cur.status);
        if (logs.length > 0 || terminal) {
          const nextCursor = logs.reduce((max, row) => Math.max(max, row.id), since);
          return Response.json(
            { status: cur.status, logs, next_cursor: nextCursor, resumable: true },
            { headers: corsHeaders },
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const cur = getOperation(target.id)!;
      return Response.json({ status: cur.status, logs: [], next_cursor: since, resumable: true }, { headers: corsHeaders });
    }

    const logs = readLogs();
    const nextCursor = logs.reduce((max, row) => Math.max(max, row.id), since);
    return Response.json({ status: target.status, operation_id: target.id, logs, next_cursor: nextCursor, resumable: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleCancelOperation(request: Request, id: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "operations.cancel");
    const user = getUserById(payload.userId);
    if (!user) throw new PermissionError("Unauthorized");
    const op = getOperation(id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    // Only admins or the user who triggered the op can cancel it.
    if (!user.is_admin && op.triggered_by !== payload.userId) {
      throw new PermissionError("Cannot cancel another user's operation");
    }
    // Pending operations have not run a side effect and requestCancel performs
    // a plain queue removal. Once forward work started, cancellation invokes
    // compensation and is therefore a destructive action.
    if (op.status !== "pending") {
      await enforceConfirmation(request, payload, "cancel_operation", "operation", String(id));
    }
    requestCancel(id);
    return Response.json({ ok: true, compensation_preview: previewCompensation(op) }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}

async function requireOperationRecoveryAccess(request: Request, id: number) {
  const payload = await requirePermission(request, "operations.cancel");
  const user = getUserById(payload.userId);
  if (!user) throw new PermissionError("Unauthorized");
  const op = getOperation(id);
  if (!op) return { payload, user, op: null };
  if (!user.is_admin && op.triggered_by !== payload.userId) {
    throw new PermissionError("Cannot recover another user's operation");
  }
  return { payload, user, op };
}

function opIsHeld(op: NonNullable<ReturnType<typeof getOperation>>): boolean {
  const keys = safeParse<string[]>(op.resource_keys, []);
  return keys.some((key) => currentHolder(key)?.opId === op.id);
}

export async function handleRetryOperation(request: Request, id: number): Promise<Response> {
  try {
    const { payload, op } = await requireOperationRecoveryAccess(request, id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    if (op.status === "done") {
      return Response.json({ error: "A successful operation does not need retrying" }, { status: 409, headers: corsHeaders });
    }
    if (opIsHeld(op)) {
      return Response.json({ error: "Operation is still executing; cancel it before retrying" }, { status: 409, headers: corsHeaders });
    }

    // Compensation retries continue on the same durable operation so already
    // completed cleanup steps stay skipped. A completed/rolled-back forward
    // attempt gets a new audit row and starts from scratch.
    const sameAttempt = ["pending", "running", "compensating", "compensation_failed"].includes(op.status);
    const stackResume = op.kind === "deploy_stack" && !sameAttempt;
    const originalInput = safeParse<Record<string, unknown>>(op.input_json, {});
    const webhookInput = op.kind === "webhook_build_source"
      ? originalInput as { sourceId: number; deliveryId: string; commit: string }
      : null;
    const retried = sameAttempt
      ? requeueOperation(op.id)
      : webhookInput
        ? retryWebhookOperationAsNew(op.id, payload.userId, webhookInput)
        : retryOperationAsNew(
          op.id,
          payload.userId,
          stackResume ? { ...originalInput, resume_operation_id: op.id } : undefined,
        );
    if (!retried) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    return Response.json(
      { ok: true, op_id: retried.id, resumed: retried.id === op.id || stackResume, resumed_from: stackResume ? op.id : undefined },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleFinalizeOperation(request: Request, id: number): Promise<Response> {
  try {
    const { op } = await requireOperationRecoveryAccess(request, id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    if (opIsHeld(op)) {
      return Response.json({ error: "Operation is still executing and cannot be finalized" }, { status: 409, headers: corsHeaders });
    }
    const body = (await request.json().catch(() => ({}))) as { status?: "auto" | "done" | "failed" };
    const requested = body.status ?? "auto";
    if (!["auto", "done", "failed"].includes(requested)) {
      return Response.json({ error: "status must be auto, done, or failed" }, { status: 400, headers: corsHeaders });
    }

    const terminal = ["done", "failed", "cancelled", "compensated", "compensation_failed"].includes(op.status);
    const start = Date.parse(`${(op.started_at || op.enqueued_at).replace(" ", "T")}Z`);
    const stale = Number.isFinite(start) && Date.now() - start >= 10 * 60_000;
    if (!terminal && !stale) {
      return Response.json(
        { error: "Operation is not terminal or stale yet; cancel it first" },
        { status: 409, headers: corsHeaders },
      );
    }

    const assessment = assessOperationResources(op);
    const next = requested === "auto" ? assessment.status : requested;
    if (next === "done" && !assessment.safeToFinalizeDone) {
      return Response.json(
        { error: `Resources do not match a successful operation: ${assessment.reason}` },
        { status: 409, headers: corsHeaders },
      );
    }
    const finalized = finalizeOperation(
      op.id,
      next,
      `operator finalized operation after resource assessment: ${assessment.reason}`,
    )!;
    applyOperationResourceStatus(op, next);
    return Response.json(
      { ok: true, op_id: finalized.id, status: finalized.status, assessment: assessment.reason },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}
