import * as keychain from "./keychain.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [secrets:${context}]`, ...args);
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  getTokens(): Promise<{
    hetzner_api_token: string;
    github_pat: string;
  }>;
}

// Desktop mode: macOS Keychain
class KeychainStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    return keychain.getSecret(key);
  }
  async set(key: string, value: string): Promise<void> {
    return keychain.setSecret(key, value);
  }
  async delete(key: string): Promise<void> {
    return keychain.deleteSecret(key);
  }
  async getTokens() {
    return keychain.getTokens();
  }
}

// Server mode: encrypted SQLite storage
class DbSecretStore implements SecretStore {
  private encryptionKey: CryptoKey | null = null;

  private async getKey(): Promise<CryptoKey> {
    if (this.encryptionKey) return this.encryptionKey;
    const secret = process.env.JWT_SECRET || "ocd-dev-default-secret-change-in-production";
    const rawKey = new TextEncoder().encode(secret);
    const keyMaterial = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);
    this.encryptionKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ocd-secrets"), info: new TextEncoder().encode("encryption") },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return this.encryptionKey;
  }

  async get(key: string): Promise<string | null> {
    // Lazy import to avoid circular dep at module load time
    const { default: db } = await import("./db.ts");
    const row = db.query("SELECT encrypted_value, iv FROM encrypted_secrets WHERE key = ?").get(key) as any;
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

  async set(key: string, value: string): Promise<void> {
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
    db.query("INSERT OR REPLACE INTO encrypted_secrets (key, encrypted_value, iv) VALUES (?, ?, ?)").run(key, ctB64, ivB64);
  }

  async delete(key: string): Promise<void> {
    const { default: db } = await import("./db.ts");
    db.query("DELETE FROM encrypted_secrets WHERE key = ?").run(key);
  }

  async getTokens() {
    const [hetzner_api_token, github_pat] = await Promise.all([
      this.get("hetzner_api_token"),
      this.get("github_pat"),
    ]);
    return {
      hetzner_api_token: hetzner_api_token ?? "",
      github_pat: github_pat ?? "",
    };
  }
}

export const isServerMode = process.env.OCD_MODE === "server";

export const secretStore: SecretStore = isServerMode ? new DbSecretStore() : new KeychainStore();

export { maskToken } from "./keychain.ts";
