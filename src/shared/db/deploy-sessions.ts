import db from "./connection.ts";

const SESSION_TTL_MINUTES = 10;

function purgeExpired(): void {
  db.run(
    `DELETE FROM deploy_sessions WHERE created_at < datetime('now', '-${SESSION_TTL_MINUTES} minutes')`,
  );
}

export function getDeploySession(userId: string, orgId: string): string | null {
  purgeExpired();
  const row = db.query("SELECT form_data FROM deploy_sessions WHERE user_id = ? AND org_id = ?").get(userId, orgId) as {
    form_data: string;
  } | null;
  return row?.form_data ?? null;
}

export function saveDeploySession(userId: string, formData: string, orgId: string): void {
  purgeExpired();
  db.query(
    "INSERT OR REPLACE INTO deploy_sessions (user_id, form_data, org_id, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(userId, formData, orgId);
}

export function deleteDeploySession(userId: string, orgId: string): void {
  db.query("DELETE FROM deploy_sessions WHERE user_id = ? AND org_id = ?").run(userId, orgId);
}
