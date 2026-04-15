import { useTempDataDir } from "./test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeEach } from "bun:test";
import db from "./db.ts";
import { secretStore, maskToken, getEncryptionKey, DEFAULT_JWT_SECRET, getJwtSecret } from "./secret-store.ts";

function clearAll() {
  db.query("DELETE FROM encrypted_secrets").run();
}

describe("secret-store: round-trip", () => {
  beforeEach(clearAll);

  test("set + get returns the original value", async () => {
    await secretStore.set("api_token", "sk-live-abc123");
    expect(await secretStore.get("api_token")).toBe("sk-live-abc123");
  });

  test("get returns null for missing key", async () => {
    expect(await secretStore.get("never-set")).toBeNull();
  });

  test("set overwrites an existing value", async () => {
    await secretStore.set("k", "v1");
    await secretStore.set("k", "v2");
    expect(await secretStore.get("k")).toBe("v2");
    const rows = db.query("SELECT COUNT(*) as n FROM encrypted_secrets WHERE key=?").get("k") as { n: number };
    expect(rows.n).toBe(1);
  });

  test("delete removes the row entirely", async () => {
    await secretStore.set("ephemeral", "x");
    await secretStore.delete("ephemeral");
    expect(await secretStore.get("ephemeral")).toBeNull();
    const row = db.query("SELECT * FROM encrypted_secrets WHERE key=?").get("ephemeral");
    expect(row).toBeNull();
  });

  test("unicode round-trips through encrypt/decrypt", async () => {
    const value = "ß 中文 🚀 \n\ttab";
    await secretStore.set("unicode", value);
    expect(await secretStore.get("unicode")).toBe(value);
  });

  test("empty string is a valid value, distinct from null", async () => {
    await secretStore.set("blank", "");
    expect(await secretStore.get("blank")).toBe("");
    expect(await secretStore.get("missing")).toBeNull();
  });

  test("multiple keys coexist independently", async () => {
    await secretStore.set("a", "alpha");
    await secretStore.set("b", "bravo");
    await secretStore.set("c", "charlie");
    expect(await secretStore.get("a")).toBe("alpha");
    expect(await secretStore.get("b")).toBe("bravo");
    expect(await secretStore.get("c")).toBe("charlie");
  });

  test("large payload round-trips", async () => {
    const big = "x".repeat(100_000);
    await secretStore.set("big", big);
    expect(await secretStore.get("big")).toBe(big);
  });
});

describe("secret-store: encryption properties", () => {
  beforeEach(clearAll);

  test("each set uses a fresh random IV (no determinism leak)", async () => {
    await secretStore.set("k", "same-value");
    const row1 = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key=?").get("k") as { encrypted_value: string; iv: string };
    await secretStore.set("k", "same-value");
    const row2 = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key=?").get("k") as { encrypted_value: string; iv: string };
    expect(row1.iv).not.toBe(row2.iv);
    // Ciphertext must also change since AES-GCM mixes IV into the output.
    expect(row1.encrypted_value).not.toBe(row2.encrypted_value);
  });

  test("tampered ciphertext returns null (not thrown)", async () => {
    await secretStore.set("k", "secret");
    // Flip one byte of the ciphertext.
    const row = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key=?").get("k") as { encrypted_value: string; iv: string };
    const buf = Buffer.from(row.encrypted_value, "base64");
    buf[0] ^= 0xff;
    db.query("UPDATE encrypted_secrets SET encrypted_value=? WHERE key=?").run(buf.toString("base64"), "k");
    expect(await secretStore.get("k")).toBeNull();
  });

  test("tampered IV returns null", async () => {
    await secretStore.set("k", "secret");
    const row = db.query("SELECT iv FROM encrypted_secrets WHERE key=?").get("k") as { iv: string };
    const buf = Buffer.from(row.iv, "base64");
    buf[0] ^= 0xff;
    db.query("UPDATE encrypted_secrets SET iv=? WHERE key=?").run(buf.toString("base64"), "k");
    expect(await secretStore.get("k")).toBeNull();
  });

  test("ciphertext is not a recognisable substring of the plaintext", async () => {
    await secretStore.set("k", "plaintext-marker-xyzzy");
    const row = db.query("SELECT encrypted_value FROM encrypted_secrets WHERE key=?").get("k") as { encrypted_value: string };
    expect(row.encrypted_value).not.toContain("plaintext-marker-xyzzy");
    expect(row.encrypted_value).not.toContain("xyzzy");
  });

  test("getEncryptionKey returns the same cached CryptoKey on subsequent calls", async () => {
    const k1 = await getEncryptionKey();
    const k2 = await getEncryptionKey();
    expect(k1).toBe(k2);
  });

  test("getJwtSecret falls back to DEFAULT_JWT_SECRET when env var unset", () => {
    const prev = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(getJwtSecret()).toBe(DEFAULT_JWT_SECRET);
    if (prev !== undefined) process.env.JWT_SECRET = prev;
  });
});

describe("secret-store: getProviderToken", () => {
  beforeEach(clearAll);

  test("returns empty string when the active provider has no token stored", async () => {
    expect(await secretStore.getProviderToken()).toBe("");
  });
});

describe("maskToken", () => {
  test("empty input stays empty", () => {
    expect(maskToken("")).toBe("");
  });

  test("short tokens render as four stars", () => {
    expect(maskToken("abc")).toBe("****");
    expect(maskToken("1234567")).toBe("****"); // length 7 < 8
  });

  test("at length 8+, shows first 4 and last 4", () => {
    expect(maskToken("abcdefgh")).toBe("abcd...efgh");
    expect(maskToken("supersecrettoken123")).toBe("supe...n123");
  });
});
