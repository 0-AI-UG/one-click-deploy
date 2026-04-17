import { getEncryptionKey } from "./secret-store.ts";
import type { AppRow } from "./db/apps.ts";

export const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

export type EnvVarEntry = {
  key: string;
  value: string;
  encrypted_value?: string;
  iv?: string;
  secret: boolean;
  updated_at: string;
};

export type EnvVarsV2 = {
  version: 2;
  entries: EnvVarEntry[];
};

/** Parse env vars from DB column. Handles both old Record<string,string> and v2 format. */
export function parseEnvVars(raw: string | null | undefined): EnvVarsV2 {
  if (!raw) return { version: 2, entries: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 2 && Array.isArray(parsed.entries)) {
      return parsed as EnvVarsV2;
    }
    // Old format: plain Record<string, string>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries: EnvVarEntry[] = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: String(value),
        secret: false,
        updated_at: new Date().toISOString(),
      }));
      return { version: 2, entries };
    }
    return { version: 2, entries: [] };
  } catch {
    return { version: 2, entries: [] };
  }
}

/** Serialize env var entries for DB storage. */
export function serializeEnvVars(entries: EnvVarEntry[]): string {
  return JSON.stringify({ version: 2, entries });
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

/** Decrypt all entries and return a flat Record<string, string> for container deploy. */
export async function resolveEnvVarsForDeploy(
  environmentEnvRaw?: string | null,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  if (environmentEnvRaw) {
    const env = parseEnvVars(environmentEnvRaw);
    for (const entry of env.entries) {
      result[entry.key] = entry.secret && entry.encrypted_value && entry.iv
        ? await decryptValue(entry.encrypted_value, entry.iv)
        : entry.value;
    }
  }

  return result;
}

/** Mask secret values for API responses. Strips encrypted_value/iv. */
export function maskEnvVarsForResponse(parsed: EnvVarsV2): EnvVarEntry[] {
  return parsed.entries.map((entry) => ({
    key: entry.key,
    value: entry.secret ? SECRET_MASK : entry.value,
    secret: entry.secret,
    updated_at: entry.updated_at,
  }));
}

/** Merge incoming env var update with existing stored entries.
 *  - If incoming secret value === SECRET_MASK, preserves existing encrypted value
 *  - If incoming secret value is real, encrypts it
 *  - Entries not in incoming are removed */
export async function mergeEnvVarUpdate(
  existing: EnvVarsV2,
  incoming: Array<{ key: string; value: string; secret: boolean }>,
): Promise<EnvVarsV2> {
  const now = new Date().toISOString();
  const existingByKey = new Map(existing.entries.map((e) => [e.key, e]));

  const entries: EnvVarEntry[] = [];
  for (const item of incoming) {
    const prev = existingByKey.get(item.key);

    if (item.secret) {
      if (item.value === SECRET_MASK && prev?.secret && prev.encrypted_value && prev.iv) {
        // Preserve existing secret unchanged
        entries.push(prev);
      } else {
        // New secret or changed value — encrypt
        const { encrypted_value, iv } = await encryptValue(item.value);
        entries.push({
          key: item.key,
          value: "",
          encrypted_value,
          iv,
          secret: true,
          updated_at: now,
        });
      }
    } else {
      // Non-secret: store plaintext
      // If switching from secret to non-secret and value is still the mask,
      // decrypt the old value so we don't store "••••••••" as plaintext.
      let plainValue = item.value;
      if (item.value === SECRET_MASK && prev?.secret && prev.encrypted_value && prev.iv) {
        plainValue = await decryptValue(prev.encrypted_value, prev.iv);
      }
      const changed = !prev || prev.value !== plainValue || prev.secret !== false;
      entries.push({
        key: item.key,
        value: plainValue,
        secret: false,
        updated_at: changed ? now : (prev?.updated_at ?? now),
      });
    }
  }

  return { version: 2, entries };
}

/** Convert incoming env vars from API (either old Record or new array format) to entries and encrypt secrets. */
export async function processIncomingEnvVars(
  input: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>,
): Promise<EnvVarsV2> {
  const now = new Date().toISOString();
  const items = Array.isArray(input)
    ? input
    : Object.entries(input).map(([key, value]) => ({ key, value, secret: false }));

  const entries: EnvVarEntry[] = [];
  for (const item of items) {
    if (item.secret) {
      const { encrypted_value, iv } = await encryptValue(item.value);
      entries.push({ key: item.key, value: "", encrypted_value, iv, secret: true, updated_at: now });
    } else {
      entries.push({ key: item.key, value: item.value, secret: false, updated_at: now });
    }
  }

  return { version: 2, entries };
}

/** Convenience: resolve all env vars for an app from its linked environment. */
export async function resolveAppEnvVars(app: AppRow): Promise<Record<string, string>> {
  const db = await import("./db.ts");
  const envRow = app.environment_id ? db.getEnvironmentUnscoped(app.environment_id) : null;
  return resolveEnvVarsForDeploy(envRow?.env_vars);
}
