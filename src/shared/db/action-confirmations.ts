import db from "./connection.ts";

export interface ActionConfirmationRow {
  confirm_code: string;
  user_code: string;
  user_id: string;
  action: string;
  summary: string;
  resource_type: string;
  resource_id: string;
  status: "pending" | "confirmed" | "denied" | "expired";
  expires_at: number;
  created_at: number;
}

function cleanupExpiredConfirmations(): void {
  db.run(
    "UPDATE action_confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
    [Date.now()],
  );
}

export function insertConfirmation(
  confirmCode: string,
  userCode: string,
  userId: string,
  action: string,
  summary: string,
  resourceType: string,
  resourceId: string,
  expiresAt: number,
): void {
  cleanupExpiredConfirmations();
  const now = Date.now();
  db.run(
    "INSERT INTO action_confirmations (confirm_code, user_code, user_id, action, summary, resource_type, resource_id, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    [confirmCode, userCode, userId, action, summary, resourceType, resourceId, expiresAt, now],
  );
}

export function getByConfirmCode(confirmCode: string): ActionConfirmationRow | null {
  return (
    (db
      .query<ActionConfirmationRow, [string]>(
        "SELECT * FROM action_confirmations WHERE confirm_code = ? LIMIT 1",
      )
      .get(confirmCode) as ActionConfirmationRow | null) ?? null
  );
}

export function getByUserCode(userCode: string): ActionConfirmationRow | null {
  return (
    (db
      .query<ActionConfirmationRow, [string]>(
        "SELECT * FROM action_confirmations WHERE user_code = ? LIMIT 1",
      )
      .get(userCode) as ActionConfirmationRow | null) ?? null
  );
}

export function setConfirmationStatus(
  confirmCode: string,
  status: "confirmed" | "denied" | "expired",
): boolean {
  const info = db.run(
    "UPDATE action_confirmations SET status = ? WHERE confirm_code = ? AND status = 'pending' AND expires_at >= ?",
    [status, confirmCode, Date.now()],
  );
  return info.changes > 0;
}

export function setConfirmationStatusByUserCode(
  userCode: string,
  status: "confirmed" | "denied" | "expired",
  userId: string,
): boolean {
  const info = db.run(
    "UPDATE action_confirmations SET status = ? WHERE user_code = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?",
    [status, userCode, userId, Date.now()],
  );
  return info.changes > 0;
}

export function deleteConfirmation(confirmCode: string): void {
  db.run("DELETE FROM action_confirmations WHERE confirm_code = ?", [confirmCode]);
}

/**
 * Atomically consume a browser-approved confirmation at destroy time. Deletes
 * and returns true ONLY if a row matches every binding — confirm_code, user_id,
 * action, resource_type, resource_id — is in 'confirmed' status, and is not yet
 * expired. Any mismatch (wrong resource, wrong action, not approved, expired)
 * leaves the row untouched and returns false.
 */
export function consumeConfirmation(
  confirmCode: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string,
): boolean {
  const info = db.run(
    "DELETE FROM action_confirmations WHERE confirm_code=? AND user_id=? AND action=? AND resource_type=? AND resource_id=? AND status='confirmed' AND expires_at>=?",
    [confirmCode, userId, action, resourceType, resourceId, Date.now()],
  );
  return info.changes > 0;
}
