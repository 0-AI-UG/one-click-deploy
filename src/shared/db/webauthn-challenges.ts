import db from "./connection.ts";

const DEFAULT_TTL_MS = 60_000;

function cleanupExpiredChallenges(): void {
  db.run("DELETE FROM webauthn_challenges WHERE expires_at < ?", [Date.now()]);
}

/**
 * Persist a new challenge for (userId, kind). Returns the generated row id.
 * Lazily prunes expired rows on every call so the table stays bounded.
 */
export function saveChallenge(
  userId: string,
  challenge: string,
  kind: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  cleanupExpiredChallenges();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    "INSERT INTO webauthn_challenges (id, user_id, challenge, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, challenge, kind, now + ttlMs, now],
  );
  return id;
}

/**
 * Fetch-and-delete the most-recent unexpired challenge for (userId, kind).
 * Returns the challenge string so callers can pass it as `expectedChallenge`
 * to the @simplewebauthn/server verify functions. Returns null if not found or
 * expired.
 *
 * Keying by (userId, kind) instead of only userId allows concurrent flows of
 * different kinds for the same user without clobbering each other.
 */
export function fetchAndDeleteChallenge(
  userId: string,
  kind: string,
): string | null {
  const now = Date.now();
  const row = db
    .query<{ id: string; challenge: string }, [string, string, number]>(
      "SELECT id, challenge FROM webauthn_challenges WHERE user_id = ? AND kind = ? AND expires_at >= ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(userId, kind, now);

  if (!row) return null;

  db.run("DELETE FROM webauthn_challenges WHERE id = ?", [row.id]);
  return row.challenge;
}

/**
 * Consume a challenge by value: delete it if it exists, matches challenge+kind,
 * and has not expired. Returns true when consumed. Useful for tests and for
 * callers that already know the expected challenge value.
 */
export function consumeChallenge(
  userId: string,
  challenge: string,
  kind: string,
): boolean {
  const now = Date.now();
  const row = db
    .query<{ id: string }, [string, string, string, number]>(
      "SELECT id FROM webauthn_challenges WHERE user_id = ? AND challenge = ? AND kind = ? AND expires_at >= ? LIMIT 1",
    )
    .get(userId, challenge, kind, now);

  if (!row) return false;

  db.run("DELETE FROM webauthn_challenges WHERE id = ?", [row.id]);
  return true;
}
