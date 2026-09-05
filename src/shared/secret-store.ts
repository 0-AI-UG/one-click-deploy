function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [secrets:${context}]`, ...args);
}

// Dev-only fallback. Never used in production: getJwtSecret() throws if
// JWT_SECRET is unset when NODE_ENV=production. The constant exists so dev
// runs (`bun run dev`) and the test suite have a stable key — encrypted_secrets
// rows written under one process keep decrypting in the next.
export const DEFAULT_JWT_SECRET = "ocd-dev-default-secret-change-in-production";

let _warnedDevSecret = false;

export function getJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (process.env.NODE_ENV === "production") {
    if (!fromEnv) {
      throw new Error(
        "JWT_SECRET is required in production. Set the JWT_SECRET environment variable to a random string of at least 32 characters (e.g., `openssl rand -hex 32`).",
      );
    }
    throw new Error(
      `JWT_SECRET must be at least 32 characters (got ${fromEnv.length}).`,
    );
  }

  if (!_warnedDevSecret) {
    _warnedDevSecret = true;
    log("warn", "JWT_SECRET is unset — using insecure dev default. Set JWT_SECRET before deploying to production.");
  }
  return fromEnv || DEFAULT_JWT_SECRET;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Read one infrastructure adapter's credential. Returns "" when unset. */
  getInfrastructureToken(providerId: string): Promise<string>;
}

// Shared encryption key, cached after first derivation
let _sharedEncryptionKey: CryptoKey | null = null;

export async function getEncryptionKey(): Promise<CryptoKey> {
  if (_sharedEncryptionKey) return _sharedEncryptionKey;
  const secret = getJwtSecret();
  const rawKey = new TextEncoder().encode(secret);
  const keyMaterial = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);
  _sharedEncryptionKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ocd-secrets"), info: new TextEncoder().encode("encryption") },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return _sharedEncryptionKey;
}

/** Encrypt a single plaintext value. */
export async function encryptValue(plaintext: string): Promise<{ encrypted_value: string; iv: string }> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    encrypted_value: Buffer.from(ciphertext).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
  };
}

/** Decrypt a single encrypted value. */
export async function decryptValue(encrypted_value: string, iv: string): Promise<string> {
  const key = await getEncryptionKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    key,
    Buffer.from(encrypted_value, "base64"),
  );
  return new TextDecoder().decode(decrypted);
}

// Encrypted SQLite storage (AES-GCM, key derived from JWT_SECRET via HKDF)
class DbSecretStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    const { default: db } = await import("./db.ts");
    const row = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key = ?").get(key) as { encrypted_value: string; iv: string } | null;
    if (!row) return null;
    try {
      return await decryptValue(row.encrypted_value, row.iv);
    } catch (err) {
      log("get", `Failed to decrypt secret ${key}:`, err);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const { default: db } = await import("./db.ts");
    const { encrypted_value, iv } = await encryptValue(value);
    db.query("INSERT OR REPLACE INTO encrypted_secrets (key, encrypted_value, iv) VALUES (?, ?, ?)").run(key, encrypted_value, iv);
  }

  async delete(key: string): Promise<void> {
    const { default: db } = await import("./db.ts");
    db.query("DELETE FROM encrypted_secrets WHERE key = ?").run(key);
  }

  async getInfrastructureToken(providerId: string) {
    const { assignedProvider, providerSecretKey } = await import("./provider-connections.ts");
    const connection = assignedProvider("infrastructure");
    if (!connection || connection.kind !== providerId) return "";
    return (await this.get(providerSecretKey(connection.id, "api_token"))) ?? "";
  }
}

export const secretStore: SecretStore = new DbSecretStore();

export function getInfrastructureToken(providerId: string) {
  return secretStore.getInfrastructureToken(providerId);
}

export function maskToken(token: string): string {
  if (!token || token.length < 8) return token ? "****" : "";
  return token.slice(0, 4) + "..." + token.slice(-4);
}
