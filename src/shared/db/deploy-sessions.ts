import db from "./connection.ts";

const SESSION_TTL_MINUTES = 10;

function purgeExpired(): void {
  db.run(
    `DELETE FROM deploy_sessions WHERE created_at < datetime('now', '-${SESSION_TTL_MINUTES} minutes')`,
  );
}

export function getDeploySession(userId: string): string | null {
  purgeExpired();
  const row = db.query("SELECT form_data FROM deploy_sessions WHERE user_id = ?").get(userId) as {
    form_data: string;
  } | null;
  return row?.form_data ?? null;
}

export function saveDeploySession(userId: string, formData: string): void {
  purgeExpired();
  db.query(
    "INSERT OR REPLACE INTO deploy_sessions (user_id, form_data, created_at) VALUES (?, ?, datetime('now'))",
  ).run(userId, formData);
}

export function deleteDeploySession(userId: string): void {
  db.query("DELETE FROM deploy_sessions WHERE user_id = ?").run(userId);
}
