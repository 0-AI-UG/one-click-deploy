import { useTempDataDir } from "../test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeEach } from "bun:test";
import { saveChallenge, fetchAndDeleteChallenge, consumeChallenge } from "./webauthn-challenges.ts";
import {
  insertDeviceCode,
  lookupByUserCode,
  confirmDeviceCodeRow,
  getDeviceCodeRow,
  deleteDeviceCode,
} from "./device-auth-codes.ts";

// ─────────────────────────────────────────────
// WebAuthn challenge store tests
// ─────────────────────────────────────────────

describe("webauthn_challenges", () => {
  test("save and fetch challenge returns correct value", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-abc", "register");
    const result = fetchAndDeleteChallenge(userId, "register");
    expect(result).toBe("chal-abc");
  });

  test("fetchAndDeleteChallenge is consume-once — second call returns null", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-xyz", "login");
    const first = fetchAndDeleteChallenge(userId, "login");
    const second = fetchAndDeleteChallenge(userId, "login");
    expect(first).toBe("chal-xyz");
    expect(second).toBeNull();
  });

  test("two challenges of different kinds for same user are both consumable", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-reg", "register");
    saveChallenge(userId, "chal-login", "login");

    const reg = fetchAndDeleteChallenge(userId, "register");
    const login = fetchAndDeleteChallenge(userId, "login");

    expect(reg).toBe("chal-reg");
    expect(login).toBe("chal-login");
  });

  test("challenge for different user is not returned", () => {
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    saveChallenge(userA, "chal-a", "register");
    const result = fetchAndDeleteChallenge(userB, "register");
    expect(result).toBeNull();
  });

  test("expired challenge is not returned by fetchAndDeleteChallenge", () => {
    const userId = crypto.randomUUID();
    // Save with negative TTL so it's already expired
    saveChallenge(userId, "chal-expired", "register", -1000);
    const result = fetchAndDeleteChallenge(userId, "register");
    expect(result).toBeNull();
  });

  test("consumeChallenge by value succeeds for valid challenge", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-consume", "password_reset");
    const ok = consumeChallenge(userId, "chal-consume", "password_reset");
    expect(ok).toBe(true);
  });

  test("consumeChallenge fails for wrong kind", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-kind", "register");
    const ok = consumeChallenge(userId, "chal-kind", "login");
    expect(ok).toBe(false);
  });

  test("consumeChallenge fails for expired challenge", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-exp", "login", -5000);
    const ok = consumeChallenge(userId, "chal-exp", "login");
    expect(ok).toBe(false);
  });

  test("multiple concurrent challenges same userId+kind — both independently consumable", () => {
    const userId = crypto.randomUUID();
    saveChallenge(userId, "chal-first", "register");
    saveChallenge(userId, "chal-second", "register");
    // Both challenges are independently consumable; order is not guaranteed
    const first = fetchAndDeleteChallenge(userId, "register");
    expect(first).not.toBeNull();
    const second = fetchAndDeleteChallenge(userId, "register");
    expect(second).not.toBeNull();
    // They should be distinct values
    expect(first).not.toBe(second);
    // No more challenges left
    const third = fetchAndDeleteChallenge(userId, "register");
    expect(third).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Device-auth code store tests
// ─────────────────────────────────────────────

/** Generate a random 8-char user code for isolation between test runs */
function randomUserCode(): string {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "A");
  const rand2 = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "A");
  return rand + "-" + rand2;
}

describe("device_auth_codes", () => {
  const FUTURE = () => Date.now() + 10 * 60 * 1000;
  const PAST = () => Date.now() - 1000;

  test("insert and lookup by user_code returns pending row", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, FUTURE());
    const row = lookupByUserCode(userCode);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.device_code).toBe(deviceCode);
  });

  test("getDeviceCodeRow returns row by device_code", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, FUTURE());
    const row = getDeviceCodeRow(deviceCode);
    expect(row).not.toBeNull();
    expect(row!.user_code).toBe(userCode);
  });

  test("getDeviceCodeRow returns null for unknown device_code", () => {
    const row = getDeviceCodeRow("does-not-exist-" + crypto.randomUUID());
    expect(row).toBeNull();
  });

  test("confirmDeviceCodeRow updates status to confirmed", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, FUTURE());
    const ok = confirmDeviceCodeRow(userCode, "user-abc");
    expect(ok).toBe(true);
    const row = getDeviceCodeRow(deviceCode);
    expect(row!.status).toBe("confirmed");
    expect(row!.user_id).toBe("user-abc");
  });

  test("confirmDeviceCodeRow returns false for already confirmed code", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, FUTURE());
    confirmDeviceCodeRow(userCode, "user-1");
    const ok2 = confirmDeviceCodeRow(userCode, "user-2");
    expect(ok2).toBe(false);
  });

  test("confirmDeviceCodeRow returns false for expired code", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, PAST());
    const ok = confirmDeviceCodeRow(userCode, "user-x");
    expect(ok).toBe(false);
  });

  test("deleteDeviceCode removes the row", () => {
    const deviceCode = crypto.randomUUID();
    const userCode = randomUserCode();
    insertDeviceCode(deviceCode, userCode, FUTURE());
    deleteDeviceCode(deviceCode);
    const row = getDeviceCodeRow(deviceCode);
    expect(row).toBeNull();
  });

  test("lookupByUserCode returns null for unknown code", () => {
    const row = lookupByUserCode("UNKN-" + Math.random().toString(36).slice(2, 6).toUpperCase());
    expect(row).toBeNull();
  });
});
