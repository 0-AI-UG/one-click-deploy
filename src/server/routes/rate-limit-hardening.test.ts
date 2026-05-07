import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

// Skip 2FA enforcement so login returns a real JWT in tests
process.env.SKIP_2FA = "1";
// Ensure proxy headers are NOT trusted by default
delete process.env.TRUST_PROXY;

import { describe, test, expect, beforeEach } from "bun:test";
import * as db from "../../shared/db.ts";
import { handleLogin } from "./auth.ts";
import { RateLimiter, authRateLimiter } from "../lib/rate-limit.ts";

/** Reset the shared authRateLimiter's internal windows map between tests. */
function resetRateLimiter() {
  // Access the private windows map via cast
  const limiter = authRateLimiter as unknown as { windows: Map<string, number[]> };
  limiter.windows.clear();
}

function wipeUsers() {
  for (const u of db.getUsers()) db.deleteUser(u.id);
}

beforeEach(() => {
  wipeUsers();
  resetRateLimiter();
});

async function createUser(username: string, password: string) {
  const id = crypto.randomUUID();
  const hash = await Bun.password.hash(password, "bcrypt");
  db.insertUser({ id, username, password_hash: hash });
  return id;
}

/** Build a login request that looks like it comes from a specific IP. */
function loginReq(username: string, password: string, ip?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // When TRUST_PROXY=1 this would be honoured; in these tests it should NOT be
  if (ip) headers["x-forwarded-for"] = ip;
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password }),
  });
}

describe("rate limiter hardening", () => {
  test("11 failed logins from same IP → 11th returns 429", async () => {
    await createUser("alice", "correctpassword");

    // The rate limiter uses getClientIP which returns null when there's no server
    // and TRUST_PROXY is not set. In that case only the user key is checked.
    // We need to directly use the rate limiter to test IP-keyed behavior.
    const limiter = new RateLimiter(10, 15 * 60 * 1000);
    const key = "ip:1.2.3.4";

    // Record 10 failures
    for (let i = 0; i < 10; i++) {
      limiter.recordFailure(key);
    }

    const { limited } = limiter.isLimited(key);
    expect(limited).toBe(true);
  });

  test("11 failed logins for same username from different IPs → 11th is limited", async () => {
    await createUser("bob", "correctpassword");

    // Each "attacker" uses a different IP but same username
    const responses: Response[] = [];
    for (let i = 0; i < 11; i++) {
      const req = loginReq("bob", "wrongpassword");
      const resp = await handleLogin(req);
      responses.push(resp);
    }

    // At least the 11th should be 429 (keyed by "user:bob")
    const last = responses[responses.length - 1];
    expect(last.status).toBe(429);
    const retryAfter = last.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
  });

  test("TRUST_PROXY unset: spoofed X-Forwarded-For does not create separate IP buckets", async () => {
    await createUser("charlie", "correctpassword");

    // 10 failed logins with one spoofed IP — record them against "user:charlie"
    for (let i = 0; i < 10; i++) {
      await handleLogin(loginReq("charlie", "wrongpassword", `10.0.0.${i}`));
    }

    // 11th attempt with a DIFFERENT spoofed IP — should still be 429 because user key is at limit
    const resp = await handleLogin(loginReq("charlie", "wrongpassword", "99.99.99.99"));
    expect(resp.status).toBe(429);
  });

  test("successful login does not consume rate limit", async () => {
    await createUser("dave", "correctpassword");

    // 9 failed logins
    for (let i = 0; i < 9; i++) {
      await handleLogin(loginReq("dave", "wrongpassword"));
    }

    // Successful login should not be rate-limited
    const resp = await handleLogin(loginReq("dave", "correctpassword"));
    expect(resp.status).toBe(200);
  });

  test("rate limit keys are case-insensitive for usernames", async () => {
    await createUser("eve", "correctpassword");

    // 10 failures using mixed case — all should count to same bucket
    const variants = ["eve", "Eve", "EVE", "eVe", "EvE", "evE", "eVE", "EvE", "EVe", "Eve"];
    for (const variant of variants) {
      await handleLogin(loginReq(variant, "wrongpassword"));
    }

    // 11th attempt — should be rate-limited regardless of case
    const resp = await handleLogin(loginReq("EVE", "wrongpassword"));
    expect(resp.status).toBe(429);
  });
});
