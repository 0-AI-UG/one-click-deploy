import db from "./connection.ts";

export function getSettings(): Record<string, string> {
  const rows = db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function saveSetting(key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value
  );
}

/** The shared secret every server's ocd-proxy presents on wake requests
 *  (x-ocd-wake-secret). Created once (32 random bytes, hex) and stable for
 *  the fleet's lifetime — regenerating would invalidate every shipped
 *  /etc/ocd-proxy/config.json at once. */
export function ensureProxyWakeSecret(): string {
  const existing = getSettings()["proxy_wake_secret"];
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  saveSetting("proxy_wake_secret", secret);
  return secret;
}
