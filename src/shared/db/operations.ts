import db from "./connection.ts";

export type OperationStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "compensating"
  | "compensated"
  | "compensation_failed"
  | "cancelled";

export type StepPhase = "forward" | "compensate";
export type StepStatus = "started" | "executing" | "ok" | "skipped" | "failed";

export type OperationRow = {
  id: number;
  kind: string;
  resource_keys: string;
  input_json: string;
  status: OperationStatus;
  parent_id: number | null;
  attempt: number;
  scheduled_for: string | null;
  last_step: string | null;
  error_json: string | null;
  trigger: string;
  triggered_by: string;
  idempotency_key: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type OperationStepRow = {
  op_id: number;
  seq: number;
  step: string;
  phase: StepPhase;
  status: StepStatus;
  output_json: string | null;
  detail: string;
  started_at: string;
  finished_at: string | null;
};

export type EnqueueInput = {
  kind: string;
  resourceKeys: string[];
  input: unknown;
  trigger: string;
  triggeredBy?: string;
  parentId?: number;
  scheduledFor?: string | null;
  idempotencyKey?: string | null;
};

export function enqueueOperation(args: EnqueueInput): OperationRow {
  if (args.idempotencyKey) {
    const existing = db
      .query("SELECT * FROM operations WHERE idempotency_key = ?")
      .get(args.idempotencyKey) as OperationRow | null;
    if (existing) return existing;
  }
  return db
    .query(
      `INSERT INTO operations
        (kind, resource_keys, input_json, trigger, triggered_by, parent_id, scheduled_for, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      args.kind,
      JSON.stringify(args.resourceKeys),
      JSON.stringify(args.input ?? {}),
      args.trigger,
      args.triggeredBy ?? "",
      args.parentId ?? null,
      args.scheduledFor ?? null,
      args.idempotencyKey ?? null,
    ) as OperationRow;
}

export function getOperation(id: number): OperationRow | null {
  return db.query("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | null;
}

/**
 * Find the newest non-terminal (pending/running/compensating) operation of a
 * given kind whose resource_keys contains `resourceKey` (case-insensitive).
 * Used for single-flight: attaching a second request to an in-progress op
 * instead of enqueuing a duplicate. Returns null when none is in flight.
 */
export function findActiveOperationByResourceKey(kind: string, resourceKey: string): OperationRow | null {
  const rows = db
    .query(
      `SELECT * FROM operations
        WHERE kind = ? AND status IN ('pending','running','compensating')
        ORDER BY id DESC`,
    )
    .all(kind) as OperationRow[];
  const needle = resourceKey.toLowerCase();
  for (const row of rows) {
    let keys: unknown;
    try {
      keys = JSON.parse(row.resource_keys);
    } catch {
      continue;
    }
    if (Array.isArray(keys) && keys.some((k) => String(k).toLowerCase() === needle)) return row;
  }
  return null;
}

export function listPendingOperations(limit = 50): OperationRow[] {
  return db
    .query(
      `SELECT * FROM operations
        WHERE status = 'pending'
          AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
        ORDER BY enqueued_at ASC
        LIMIT ?`,
    )
    .all(limit) as OperationRow[];
}

export function listRunningOperations(): OperationRow[] {
  return db
    .query("SELECT * FROM operations WHERE status IN ('running','compensating') ORDER BY started_at ASC")
    .all() as OperationRow[];
}

export function listRecentOperations(limit = 50): OperationRow[] {
  return db
    .query(
      `SELECT * FROM operations
        WHERE status IN ('done','failed','cancelled','compensated','compensation_failed')
        ORDER BY COALESCE(finished_at, enqueued_at) DESC
        LIMIT ?`,
    )
    .all(limit) as OperationRow[];
}

export function listChildOperations(parentId: number): OperationRow[] {
  return db
    .query("SELECT * FROM operations WHERE parent_id = ? ORDER BY id ASC")
    .all(parentId) as OperationRow[];
}

/** Return the newest later operation that may have adopted one of `op`'s
 * resources. Every later operation is an ownership boundary—even an operation
 * that later failed may have durably adopted some children before failing.
 * Preserving a resource while ownership is ambiguous is strictly safer than
 * allowing an old rollback to delete it underneath a newer reconcile. */
export function findSupersedingOperation(op: OperationRow): OperationRow | null {
  const owned = expandedResourceKeys(op);
  if (owned.size === 0) return null;
  const rows = db
    .query(
      `SELECT * FROM operations
        WHERE id > ?
        ORDER BY id DESC`,
    )
    .all(op.id) as OperationRow[];
  for (const row of rows) {
    const candidate = expandedResourceKeys(row);
    const ownedMemberKeys = memberResourceKeys(owned);
    const candidateMemberKeys = memberResourceKeys(candidate);
    // Stack keys on member operations are coordination locks, not ownership
    // claims over every sibling. Two deployments for different members of
    // one stack must not fence each other's compensation merely because both
    // serialize through the same stack key. A genuinely stack-wide operation
    // still supersedes through that shared key, and two operations for the
    // same member still intersect on app identity.
    const superseded = ownedMemberKeys.size > 0 && candidateMemberKeys.size > 0
      ? [...candidateMemberKeys].some((key) => ownedMemberKeys.has(key))
      : [...candidate].some((key) => owned.has(key));
    if (superseded) return row;
  }
  return null;
}

function memberResourceKeys(keys: Set<string>): Set<string> {
  return new Set([...keys].filter((key) => key.startsWith("app:")));
}

/** Destructive children spawned by a parent's compensation inherit the
 * parent's ownership. This catches children that were durably queued before a
 * crash/cancel and prevents them from running after a newer operation adopted
 * the parent resource. */
export function findSupersedingAncestorOperation(op: OperationRow): {
  ancestor: OperationRow;
  supersededBy: OperationRow;
} | null {
  let parentId = op.parent_id;
  const seen = new Set<number>();
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = getOperation(parentId);
    if (!parent) return null;
    const supersededBy = findSupersedingOperation(parent);
    if (supersededBy) return { ancestor: parent, supersededBy };
    parentId = parent.parent_id;
  }
  return null;
}

export function markOperationRunning(id: number): void {
  db.run(
    "UPDATE operations SET status = 'running', started_at = COALESCE(started_at, datetime('now')), attempt = attempt + 1 WHERE id = ?",
    [id],
  );
}

export function markOperationFinished(
  id: number,
  status: Extract<OperationStatus, "done" | "failed" | "cancelled" | "compensated" | "compensation_failed">,
  error?: unknown,
): void {
  db.run(
    "UPDATE operations SET status = ?, finished_at = datetime('now'), error_json = ? WHERE id = ?",
    [status, error ? JSON.stringify(error) : null, id],
  );
}

export function markOperationCompensating(id: number, error?: unknown): void {
  db.run(
    "UPDATE operations SET status = 'compensating', error_json = ? WHERE id = ?",
    [error ? JSON.stringify(error) : null, id],
  );
}

/** Bump attempt counter; used when re-entering compensation after a crash. */
export function bumpAttempt(id: number): void {
  db.run("UPDATE operations SET attempt = attempt + 1 WHERE id = ?", [id]);
}

export function requestCancel(id: number): void {
  db.run(
    `UPDATE operations SET status = 'cancelled', finished_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    [id],
  );
  // If already running, engine sees the flag via a separate 'cancel_requested' check.
  // Simpler v1: also mark cancel_requested via a sentinel in error_json when running.
  db.run(
    `UPDATE operations SET error_json = json_set(COALESCE(error_json, '{}'), '$.cancel_requested', 1)
       WHERE id = ? AND status IN ('running','compensating')`,
    [id],
  );
}

/**
 * Put an interrupted operation back into the engine queue. Forward work resumes
 * from its durable completed steps; compensation resumes from its durable
 * compensation steps. The caller is responsible for ensuring no in-process
 * holder is still executing the operation.
 */
export function requeueOperation(id: number): OperationRow | null {
  const op = getOperation(id);
  if (!op) return null;
  const nextStatus = op.status === "compensation_failed" || op.status === "compensating"
    ? "compensating"
    : "pending";
  db.run(
    `UPDATE operations
        SET status = ?,
            finished_at = NULL,
            error_json = NULL,
            scheduled_for = NULL
      WHERE id = ?`,
    [nextStatus, id],
  );
  abandonInFlightSteps(id);
  return getOperation(id);
}

/** Enqueue a fresh attempt with the same immutable request envelope. */
export function retryOperationAsNew(
  id: number,
  triggeredBy: string,
  inputOverride?: unknown,
): OperationRow | null {
  const op = getOperation(id);
  if (!op) return null;
  return enqueueOperation({
    kind: op.kind,
    resourceKeys: safeStringArray(op.resource_keys),
    input: inputOverride ?? safeJson(op.input_json, {}),
    trigger: "retry",
    triggeredBy,
  });
}

/**
 * Operator acknowledgement for an irrecoverable stale operation. This is
 * intentionally a force transition: route-level recovery checks decide whether
 * the requested terminal status is safe for the affected resources.
 */
export function finalizeOperation(
  id: number,
  status: Extract<OperationStatus, "done" | "failed" | "cancelled">,
  detail: string,
): OperationRow | null {
  const op = getOperation(id);
  if (!op) return null;
  db.run(
    `UPDATE operations
        SET status = ?,
            finished_at = datetime('now'),
            error_json = ?
      WHERE id = ?`,
    [
      status,
      status === "done" ? null : JSON.stringify({ message: detail, finalized: true }),
      id,
    ],
  );
  return getOperation(id);
}

export function isCancelRequested(id: number): boolean {
  const row = db
    .query("SELECT status, error_json FROM operations WHERE id = ?")
    .get(id) as { status: string; error_json: string | null } | null;
  if (!row) return false;
  if (row.status === "cancelled") return true;
  if (!row.error_json) return false;
  try {
    const parsed = JSON.parse(row.error_json);
    return Boolean(parsed?.cancel_requested);
  } catch {
    return false;
  }
}

export function updateLastStep(id: number, step: string): void {
  db.run("UPDATE operations SET last_step = ? WHERE id = ?", [step, id]);
}

export function nextStepSeq(opId: number): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM operation_steps WHERE op_id = ?")
    .get(opId) as { next: number };
  return row.next;
}

export function insertStep(args: {
  opId: number;
  seq: number;
  step: string;
  phase: StepPhase;
  status: StepStatus;
  detail?: string;
  outputJson?: string | null;
}): void {
  db.run(
    `INSERT INTO operation_steps (op_id, seq, step, phase, status, output_json, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      args.opId,
      args.seq,
      args.step,
      args.phase,
      args.status,
      args.outputJson ?? null,
      args.detail ?? "",
    ],
  );
}

export function finishStep(args: {
  opId: number;
  seq: number;
  status: StepStatus;
  detail?: string;
  outputJson?: string | null;
}): void {
  db.run(
    `UPDATE operation_steps
        SET status = ?, detail = ?, output_json = COALESCE(?, output_json), finished_at = datetime('now')
        WHERE op_id = ? AND seq = ?`,
    [
      args.status,
      args.detail ?? "",
      args.outputJson ?? null,
      args.opId,
      args.seq,
    ],
  );
}

export function getSteps(opId: number, sinceSeq = 0): OperationStepRow[] {
  return db
    .query(
      "SELECT * FROM operation_steps WHERE op_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(opId, sinceSeq) as OperationStepRow[];
}

export function getCompletedForwardSteps(opId: number): OperationStepRow[] {
  // Includes 'skipped' so a resume that already replayed prior-attempt steps
  // still sees them on the next resume (e.g. crash during compensation).
  return db
    .query(
      `SELECT * FROM operation_steps
        WHERE op_id = ? AND phase = 'forward' AND status IN ('ok','skipped')
        ORDER BY seq ASC`,
    )
    .all(opId) as OperationStepRow[];
}

/**
 * Names of steps whose compensate phase already completed (ok or skipped).
 * Used by the runner to skip already-done compensations on resume.
 */
export function getCompletedCompensateSteps(opId: number): OperationStepRow[] {
  return db
    .query(
      `SELECT * FROM operation_steps
        WHERE op_id = ? AND phase = 'compensate' AND status IN ('ok','skipped')
        ORDER BY seq ASC`,
    )
    .all(opId) as OperationStepRow[];
}

/**
 * Latest step row for an op (any phase). Used by resume to detect a step that
 * was mid-execution (status='executing' or 'started') when the engine died.
 */
export function getLatestStep(opId: number): OperationStepRow | null {
  return db
    .query("SELECT * FROM operation_steps WHERE op_id = ? ORDER BY seq DESC LIMIT 1")
    .get(opId) as OperationStepRow | null;
}

/** Flip a step row to status='executing' immediately before its side effect. */
export function markStepExecuting(opId: number, seq: number): void {
  db.run(
    "UPDATE operation_steps SET status = 'executing' WHERE op_id = ? AND seq = ?",
    [opId, seq],
  );
}

/**
 * Reset transient 'executing'/'started' step rows on a step the runner is
 * about to retry. Called during resume so prior crash-rows don't poison
 * `getLatestStep` checks; the step is re-attempted (probe → run).
 */
export function abandonInFlightSteps(opId: number): void {
  db.run(
    `UPDATE operation_steps
        SET status = 'failed', detail = 'abandoned: engine restarted mid-step', finished_at = datetime('now')
        WHERE op_id = ? AND status IN ('started','executing')`,
    [opId],
  );
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeStringArray(raw: string): string[] {
  const parsed = safeJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

/** Expand create-time/name keys into their durable numeric identities. Resource
 * keys intentionally change from `app:create:<name>` to `app:<id>` after
 * insertion; compensation ownership must span that
 * transition or a stale create op could delete an app a later redeploy owns. */
function expandedResourceKeys(op: OperationRow): Set<string> {
  const keys = new Set(safeStringArray(op.resource_keys));
  const input = safeJson<Record<string, unknown>>(op.input_json, {});

  const tableFor = (type: "app" | "stack"): string => type === "app" ? "apps" : "stacks";
  const addNamed = (type: "app" | "stack", name: unknown): void => {
    if (typeof name !== "string" || !name) return;
    keys.add(`${type}:create:${name}`);
    keys.add(`${type}:${name}`);
    const row = db.query(`SELECT id FROM ${tableFor(type)} WHERE name = ?`).get(name) as
      | { id: number }
      | null;
    if (row) keys.add(`${type}:${row.id}`);
  };
  const addId = (type: "app" | "stack", id: unknown): void => {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return;
    keys.add(`${type}:${numeric}`);
    const row = db.query(`SELECT name FROM ${tableFor(type)} WHERE id = ?`).get(numeric) as
      | { name: string }
      | null;
    if (row) {
      keys.add(`${type}:${row.name}`);
      keys.add(`${type}:create:${row.name}`);
    }
  };

  if (op.kind === "deploy") addNamed("app", input.app_name);
  if (op.kind === "deploy_stack") addNamed("stack", input.name);
  if ("appId" in input) addId("app", input.appId);
  if ("destAppId" in input) addId("app", input.destAppId);
  if ("stackId" in input) addId("stack", input.stackId);
  return keys;
}
