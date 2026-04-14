import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { authenticateRequest } from "../lib/auth.ts";
import { requirePermission } from "../lib/permissions.ts";
import { getUserById } from "../../bun/db.ts";
import { PermissionError } from "../lib/errors.ts";
import {
  getOperation,
  getSteps,
  listPendingOperations,
  listRunningOperations,
  listRecentOperations,
  listChildOperations,
  requestCancel,
} from "../../bun/db/operations.ts";
import { getSettings } from "../../bun/db/settings.ts";
import { stepCount, listOps } from "../../engine/ops/registry.ts";

// Keys whose values may contain secrets (connection strings, passwords,
// tokens, webhook secrets, env-var values). Redacted in any op input/output
// JSON returned to API clients.
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|credential|connection_url|webhook_secret|auth_password|api_key|access_key|private_key|env_vars?|env_overrides)/i;

const REDACTED = "[redacted]";

function redact(value: unknown): unknown {
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

function toJsonRow(op: ReturnType<typeof getOperation> & {}) {
  const resourceKeys = safeParse(op.resource_keys, []);
  const input = redact(safeParse(op.input_json, {}));
  const error = op.error_json ? safeParse(op.error_json, null) : null;
  return {
    id: op.id,
    kind: op.kind,
    resource_keys: resourceKeys,
    input,
    status: op.status,
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
    await requirePermission(request, "servers.view");
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
    await requirePermission(request, "servers.view");
    const op = getOperation(id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    const steps = getSteps(id, 0).map(mapStep);
    const children = listChildOperations(id).map(toJsonRow);
    return Response.json(
      { ...toJsonRow(op), steps, children },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleOperationEvents(request: Request, id: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.view");
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const timeoutMs = Math.min(parseInt(url.searchParams.get("wait") || "15000", 10), 25000);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const op = getOperation(id);
      if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
      const steps = getSteps(id, since);
      const terminal = ["done", "failed", "cancelled", "compensated"].includes(op.status);
      if (steps.length > 0 || terminal) {
        return Response.json(
          {
            status: op.status,
            last_step: op.last_step,
            error: op.error_json ? safeParse(op.error_json, null) : null,
            steps: steps.map(mapStep),
          },
          { headers: corsHeaders },
        );
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    // Timed out with no new events — client re-polls.
    const op = getOperation(id)!;
    return Response.json(
      { status: op.status, last_step: op.last_step, steps: [] },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleCancelOperation(request: Request, id: number): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    const user = getUserById(payload.userId);
    if (!user) throw new PermissionError("Unauthorized");
    const op = getOperation(id);
    if (!op) return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    // Only admins or the user who triggered the op can cancel it.
    if (!user.is_admin && op.triggered_by !== payload.userId) {
      throw new PermissionError("Cannot cancel another user's operation");
    }
    requestCancel(id);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}
