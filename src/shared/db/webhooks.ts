import db from "./connection.ts";

export type WebhookCandidateStatus =
  | "pending"
  | "waiting_for_ci"
  | "eligible"
  | "evaluating"
  | "done"
  | "ignored"
  | "superseded";

export type WebhookCandidateRow = {
  id: number;
  repository: string;
  branch: string;
  before_sha: string;
  head_sha: string;
  origin_app_id: number;
  stack_id: number | null;
  delivery_id: string;
  status: WebhookCandidateStatus;
  ci_result: string | null;
  parent_operation_id: number | null;
  superseded_by_head: string | null;
  created_at: string;
  updated_at: string;
};

export function getWebhookCandidate(id: number): WebhookCandidateRow | null {
  return db.query("SELECT * FROM webhook_candidates WHERE id = ?").get(id) as WebhookCandidateRow | null;
}

export function getWebhookCandidateByHead(
  repository: string,
  branch: string,
  headSha: string,
): WebhookCandidateRow | null {
  return db.query(
    "SELECT * FROM webhook_candidates WHERE repository = ? AND branch = ? AND head_sha = ?",
  ).get(repository, branch, headSha) as WebhookCandidateRow | null;
}

/**
 * Persist one logical push. A duplicate head is returned unchanged. A newly
 * received head supersedes older unfinished candidates for this repo+branch.
 */
export function createWebhookCandidate(input: {
  repository: string;
  branch: string;
  beforeSha: string;
  headSha: string;
  originAppId: number;
  stackId: number | null;
  deliveryId: string;
}): { candidate: WebhookCandidateRow; created: boolean } {
  const tx = db.transaction(() => {
    const existing = getWebhookCandidateByHead(input.repository, input.branch, input.headSha);
    if (existing) return { candidate: existing, created: false };
    const latest = db.query(
      `SELECT * FROM webhook_candidates
       WHERE repository = ? AND branch = ? AND status <> 'superseded'
       ORDER BY id DESC LIMIT 1`,
    ).get(input.repository, input.branch) as WebhookCandidateRow | null;
    const candidate = db.query(
      `INSERT INTO webhook_candidates
        (repository, branch, before_sha, head_sha, origin_app_id, stack_id, delivery_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      input.repository,
      input.branch,
      input.beforeSha,
      input.headSha,
      input.originAppId,
      input.stackId,
      input.deliveryId,
    ) as WebhookCandidateRow;
    // A delayed delivery for the direct parent of an already-seen push is
    // older even though it arrived later. Persist it for audit/idempotency but
    // never let arrival order make it supersede its child.
    if (latest && latest.before_sha === input.headSha) {
      db.query(
        `UPDATE webhook_candidates
         SET status = 'superseded', superseded_by_head = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(latest.head_sha, candidate.id);
      return { candidate: getWebhookCandidate(candidate.id)!, created: true };
    }
    const superseded = db.query(
      `SELECT parent_operation_id FROM webhook_candidates
       WHERE repository = ? AND branch = ? AND id < ?
         AND status IN ('pending','waiting_for_ci','eligible','evaluating')
         AND parent_operation_id IS NOT NULL`,
    ).all(input.repository, input.branch, candidate.id) as Array<{ parent_operation_id: number }>;
    db.query(
      `UPDATE webhook_candidates
       SET status = 'superseded', superseded_by_head = ?, updated_at = datetime('now')
       WHERE repository = ? AND branch = ? AND id < ?
         AND status IN ('pending','waiting_for_ci','eligible','evaluating')`,
    ).run(input.headSha, input.repository, input.branch, candidate.id);
    for (const { parent_operation_id: operationId } of superseded) {
      db.query(
        `UPDATE operations SET status = 'cancelled', finished_at = datetime('now')
         WHERE id = ? AND status = 'pending'`,
      ).run(operationId);
      db.query(
        `UPDATE operations
         SET error_json = json_set(COALESCE(error_json, '{}'), '$.cancel_requested', 1,
           '$.superseded_by_head', ?)
         WHERE id = ? AND status IN ('running','compensating')`,
      ).run(input.headSha, operationId);
    }
    return { candidate, created: true };
  });
  return tx();
}

export function setWebhookCandidateOperation(id: number, operationId: number): void {
  db.query(
    "UPDATE webhook_candidates SET parent_operation_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(operationId, id);
}

export function updateWebhookCandidate(
  id: number,
  fields: { status?: WebhookCandidateStatus; ciResult?: string | null },
): void {
  if (fields.status !== undefined && fields.ciResult !== undefined) {
    db.query(
      "UPDATE webhook_candidates SET status = ?, ci_result = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(fields.status, fields.ciResult, id);
  } else if (fields.status !== undefined) {
    db.query(
      "UPDATE webhook_candidates SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(fields.status, id);
  } else if (fields.ciResult !== undefined) {
    db.query(
      "UPDATE webhook_candidates SET ci_result = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(fields.ciResult, id);
  }
}

export function isWebhookCandidateCurrent(candidate: WebhookCandidateRow): boolean {
  if (getWebhookCandidate(candidate.id)?.status === "superseded") return false;
  const newer = db.query(
    `SELECT id FROM webhook_candidates
     WHERE repository = ? AND branch = ? AND id > ?
       AND status <> 'superseded'
     ORDER BY id DESC LIMIT 1`,
  ).get(candidate.repository, candidate.branch, candidate.id) as { id: number } | null;
  return newer === null;
}
