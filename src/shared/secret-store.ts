function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [secrets:${context}]`, ...args);
}

// Default JWT secret used when the env var is absent. Must stay identical
// across all call sites so that encrypted_secrets rows remain decryptable
// during the self-deploy handoff.
export const DEFAULT_JWT_SECRET = "ocd-dev-default-secret-change-in-production";

export function getJwtSecret(): string {
  return process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

export interface SecretStore {
  get(key: string, orgId?: string): Promise<string | null>;
  set(key: string, value: string, orgId?: string): Promise<void>;
  delete(key: string, orgId?: string): Promise<void>;
  /** Read the active compute provider's API token. Returns "" when unset. */
  getProviderToken(orgId?: string): Promise<string>;
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

// Encrypted SQLite storage (AES-GCM, key derived from JWT_SECRET via HKDF)
class DbSecretStore implements SecretStore {
  private async getKey(): Promise<CryptoKey> {
    return getEncryptionKey();
  }

  async get(key: string, orgId?: string): Promise<string | null> {
    const { default: db } = await import("./db.ts");
    const row = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key = ? AND org_id = ?").get(key, orgId ?? "") as { encrypted_value: string; iv: string } | null;
    if (!row) return null;
    try {
      const encKey = await this.getKey();
      const iv = Buffer.from(row.iv, "base64");
      const ciphertext = Buffer.from(row.encrypted_value, "base64");
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encKey, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch (err) {
      log("get", `Failed to decrypt secret ${key}:`, err);
      return null;
    }
  }

  async set(key: string, value: string, orgId?: string): Promise<void> {
    const { default: db } = await import("./db.ts");
    const encKey = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      encKey,
      new TextEncoder().encode(value),
    );
    const ivB64 = Buffer.from(iv).toString("base64");
    const ctB64 = Buffer.from(ciphertext).toString("base64");
    db.query("INSERT OR REPLACE INTO encrypted_secrets (org_id, key, encrypted_value, iv) VALUES (?, ?, ?, ?)").run(orgId ?? "", key, ctB64, ivB64);
  }

  async delete(key: string, orgId?: string): Promise<void> {
    const { default: db } = await import("./db.ts");
    db.query("DELETE FROM encrypted_secrets WHERE key = ? AND org_id = ?").run(key, orgId ?? "");
  }

  async getProviderToken(orgId?: string) {
    const { getComputeProvider } = await import("./providers/index.ts");
    const provider = getComputeProvider();
    return (await this.get(provider.tokenKey, orgId)) ?? "";
  }
}

export const secretStore: SecretStore = new DbSecretStore();

export function getProviderToken(orgId?: string) {
  return secretStore.getProviderToken(orgId);
}

export function maskToken(token: string): string {
  if (!token || token.length < 8) return token ? "****" : "";
  return token.slice(0, 4) + "..." + token.slice(-4);
}
