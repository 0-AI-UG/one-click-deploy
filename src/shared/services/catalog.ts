import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ServiceEnvVar = {
  key: string;
  label: string;
  generate?: "password" | "username";
  default?: string;
};

export type ServiceDefinition = {
  type: string;
  label: string;
  image: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: ServiceEnvVar[];
  /** Path inside the container to back with a persistent volume. Empty/omitted = stateless. */
  volumePath: string;
  healthCmd: string;
  defaultVolumeSize: number;
  connectionUrlTemplate: string;
  icon?: string;
  color?: string;
  cmd?: string[];
  /**
   * Linux capabilities to add back after the platform's `--cap-drop=ALL`.
   * Needed by official images whose entrypoint runs as root then drops to a
   * service user (postgres/mysql/mongo/redis): `["CHOWN","SETUID","SETGID"]`
   * lets it chown its data dir and gosu/su-exec down. Omit for images that
   * already run as a fixed non-root USER — those just need a writable volume
   * root, which the host-side chown handles.
   */
  extraCaps?: string[];
  /** When true, expose this service via the panel ingress on a public domain (HTTP-facing). */
  http?: boolean;
  /** Brief description shown in the UI. */
  description?: string;
  /** Free-form category tag (e.g. "ai", "database", "search"). */
  category?: string;
};

function randomFromAlphabet(alphabet: string, len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function randomPassword(len = 24): string {
  return randomFromAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", len);
}

export function generateEnvVars(def: ServiceDefinition): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of def.requiredEnvVars) {
    if (v.generate === "password") {
      env[v.key] = randomPassword();
    } else if (v.generate === "username") {
      env[v.key] = "ocd_user";
    } else if (v.default) {
      env[v.key] = v.default;
    }
  }
  return env;
}

export function buildConnectionUrl(
  def: ServiceDefinition,
  env: Record<string, string>,
  host: string,
  port: number,
): string {
  let url = def.connectionUrlTemplate;
  url = url.replace("{host}", host);
  url = url.replace("{port}", String(port));
  for (const [k, v] of Object.entries(env)) {
    url = url.replace(`{${k}}`, encodeURIComponent(v));
  }
  return url;
}

function loadCatalog(): Record<string, ServiceDefinition> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "catalog");
  const entries: Record<string, ServiceDefinition> = {};
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    const def = JSON.parse(raw) as ServiceDefinition;
    if (!def.type) throw new Error(`Service catalog entry ${file} missing "type" field`);
    if (entries[def.type]) throw new Error(`Duplicate service type "${def.type}" (in ${file})`);
    entries[def.type] = def;
  }
  return entries;
}

export const SERVICE_CATALOG: Record<string, ServiceDefinition> = loadCatalog();

export function getCatalogEntry(type: string): ServiceDefinition | undefined {
  return SERVICE_CATALOG[type];
}

export function getCatalogEntries(): ServiceDefinition[] {
  return Object.values(SERVICE_CATALOG).sort((a, b) => a.label.localeCompare(b.label));
}
