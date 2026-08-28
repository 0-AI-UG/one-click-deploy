import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ServiceEnvVar = {
  key: string;
  label: string;
  generate?: "password" | "username";
  default?: string;
};

export type ServiceVariant = {
  /** Image repository override for this user-facing version. */
  image: string;
  /** Actual container tag; the variant key remains the version shown in the UI. */
  tag: string;
  /** Extra defaults associated with the image, such as extensions it bundles. */
  defaultEnvVars?: Record<string, string>;
};

export type ServiceDefinition = {
  type: string;
  label: string;
  image: string;
  versions: string[];
  /** Optional image/tag overrides keyed by entries in `versions`. */
  variants?: Record<string, ServiceVariant>;
  defaultPort: number;
  requiredEnvVars: ServiceEnvVar[];
  /** Internal image configuration not shown as editable credentials in the UI. */
  defaultEnvVars?: Record<string, string>;
  /** Path inside the container to back with a persistent volume. Empty/omitted = stateless. */
  volumePath: string;
  healthCmd: string;
  /** Optional idempotent command run inside the container after its first healthy probe. */
  postStartCmd?: string;
  defaultVolumeSize: number;
  connectionUrlTemplate: string;
  icon?: string;
  color?: string;
  cmd?: string[];
  /** Optional resource ceilings for services that need more than the platform defaults. */
  memoryMb?: number;
  cpus?: number;
  /**
   * Linux capabilities to add back after the platform's `--cap-drop=ALL`.
   * Needed by official images whose entrypoint runs as root then drops to a
   * service user (postgres/mysql/mongo/redis): `["CHOWN","SETUID","SETGID"]`
   * lets it chown its data dir and gosu/su-exec down. Images that normalize
   * an existing service-owned directory before dropping privileges may also
   * need `DAC_OVERRIDE` and `FOWNER`. Omit for images that
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

export function resolveServiceImage(def: ServiceDefinition, version: string): string {
  const variant = def.variants?.[version];
  return variant ? `${variant.image}:${variant.tag}` : `${def.image}:${version}`;
}

export function generateEnvVars(def: ServiceDefinition, version?: string): Record<string, string> {
  const variantDefaults = version ? def.variants?.[version]?.defaultEnvVars : undefined;
  const env: Record<string, string> = {
    ...(def.defaultEnvVars ?? {}),
    ...(variantDefaults ?? {}),
  };
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

export type ServiceRuntime = {
  host: string;
  port: number;
  internalHost: string;
  internalPort: number;
};

/** Resolve catalog-only runtime placeholders after the service port is allocated. */
export function resolveEnvVarTemplates(
  env: Record<string, string>,
  runtime: ServiceRuntime,
): Record<string, string> {
  const replacements: Record<string, string> = {
    "{host}": runtime.host,
    "{port}": String(runtime.port),
    "{internal_host}": runtime.internalHost,
    "{internal_port}": String(runtime.internalPort),
  };
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      let resolved = value;
      for (const [placeholder, replacement] of Object.entries(replacements)) {
        resolved = resolved.replaceAll(placeholder, replacement);
      }
      return [key, resolved];
    }),
  );
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
