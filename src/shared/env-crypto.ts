import { encryptValue, decryptValue } from "./secret-store.ts";
import type { AppRow } from "./db/apps.ts";

export { encryptValue, decryptValue };

export const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

const SUSPICIOUS_SECRET_KEY =
  /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY|ACCESS_KEY_ID|CREDENTIALS?|DATABASE_URL|REDIS_URL|MONGO_URL|CONNECTION_STRING|CONNECTION_URL|DSN)$/i;

/** Names that should never be persisted as plaintext even when an older or
 * third-party client forgets to set `secret: true`. */
export function isSuspiciousSecretKey(key: string): boolean {
  return SUSPICIOUS_SECRET_KEY.test(key.trim());
}

export function suspiciousPlaintextKeys(
  input: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>,
): string[] {
  const items = Array.isArray(input)
    ? input
    : Object.entries(input).map(([key, value]) => ({ key, value, secret: false }));
  return [...new Set(items.filter((item) => !item.secret && isSuspiciousSecretKey(item.key)).map((item) => item.key))];
}

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

export function projectEnvVars(
  vars: Record<string, string>,
  projection: string[] | null | undefined,
): Record<string, string> {
  if (projection == null) return vars;
  const allowed = new Set(projection);
  return Object.fromEntries(Object.entries(vars).filter(([key]) => allowed.has(key)));
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
    const secret = item.secret || isSuspiciousSecretKey(item.key);

    if (secret) {
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
    if (item.secret || isSuspiciousSecretKey(item.key)) {
      const { encrypted_value, iv } = await encryptValue(item.value);
      entries.push({ key: item.key, value: "", encrypted_value, iv, secret: true, updated_at: now });
    } else {
      entries.push({ key: item.key, value: item.value, secret: false, updated_at: now });
    }
  }

  return { version: 2, entries };
}

/** Platform-injected env vars every app container receives: its own stable
 *  port-less internal address behind the per-app VIP proxy. HTTP-routed apps
 *  (internal_protocol='http') get `http://<name>.ocd.internal` (the VIP
 *  listens on :80); TCP-routed apps get `tcp://<name>.ocd.internal:<container_port>`
 *  (the VIP mirrors the app's own port). The proxy also listens on the legacy
 *  internal_port so already-deployed apps' baked env keeps working.
 *  User-defined vars with the same key always win over these. */
export function platformEnvVars(
  app: Pick<AppRow, "name" | "internal_protocol" | "container_port">,
): Record<string, string> {
  const host = `${app.name}.ocd.internal`;
  if (app.internal_protocol === "tcp") {
    return {
      OCD_INTERNAL_URL: `tcp://${host}:${app.container_port}`,
      OCD_INTERNAL_HOST: host,
      OCD_INTERNAL_PORT: String(app.container_port),
    };
  }
  return {
    OCD_INTERNAL_URL: `http://${host}`,
    OCD_INTERNAL_HOST: host,
    OCD_INTERNAL_PORT: "80",
  };
}

/** Convenience: resolve all env vars for an app from its linked environment,
 *  merged over the platform-injected OCD_INTERNAL_* vars (user vars win).
 *  Single choke point for redeploy/wake/rolling/scale-up/lifecycle/rollback/
 *  reconciler; the first-deploy path (ops/deploy.ts buildAndRunContainer)
 *  merges platformEnvVars manually because it resolves env vars before the
 *  app row exists.
 *
 *  Staging siblings are no different from any other app here: they link to an
 *  environment the user selected explicitly (webhook_staging_environment_id on
 *  the production app) and resolve only that env. User vars win over the
 *  sibling's own platform vars (its OCD_INTERNAL_* point at itself). */
export async function resolveAppEnvVars(app: AppRow): Promise<Record<string, string>> {
  const db = await import("./db.ts");
  const ownRow = app.environment_id ? db.getEnvironment(app.environment_id) : null;
  let ownVars = await resolveEnvVarsForDeploy(ownRow?.env_vars);
  const projection = db.parseAppEnvProjection(app);
  ownVars = projectEnvVars(ownVars, projection);
  return { ...platformEnvVars(app), ...ownVars };
}
