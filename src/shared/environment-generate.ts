import * as db from "./db.ts";
import { parseEnvVars, processIncomingEnvVars, serializeEnvVars } from "./env-crypto.ts";

/** Explicit, create-only credential initialization. Never rotates an existing key. */
export async function generateEnvironmentValue(environmentId: number, key: string, type: "password" | "username"): Promise<boolean> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid environment key");
  if (type !== "password" && type !== "username") throw new Error("type must be password or username");
  const environment = db.getEnvironment(environmentId);
  if (!environment) throw new Error("Environment not found");
  if (parseEnvVars(environment.env_vars).entries.some(entry => entry.key === key)) return false;
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const value = type === "username" ? `ocd_${random.slice(0, 16)}` : random;
  const incoming = await processIncomingEnvVars([{ key, value, secret: type === "password" }]);
  // Re-read after encryption's async boundary. The check and write below are
  // synchronous, so simultaneous initialization requests cannot rotate a key.
  const current = db.getEnvironment(environmentId);
  if (!current) throw new Error("Environment not found");
  const entries = parseEnvVars(current.env_vars).entries;
  if (entries.some(entry => entry.key === key)) return false;
  db.updateEnvironment(environmentId, current.name, serializeEnvVars([...entries, ...incoming.entries]));
  db.markAppsEnvironmentStaleForKeys(environmentId, [key]);
  return true;
}
