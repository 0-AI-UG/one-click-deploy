import db from "./connection.ts";

export function getSettings(): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function saveSetting(key: string, value: string) {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value
  );
}
