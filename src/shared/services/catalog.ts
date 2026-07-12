import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ServiceEnvVar = {
  key: string;
  label: string;
  generate?: "password" | "username";
  default?: string;
};

/** A secret value generated at deploy time and written to the service's env. */
export type ServiceSecretSpec = {
  key: string;
  /** password = 24 alnum chars, strong-password = 24 chars w/ guaranteed
   *  upper+lower+digit+symbol (for policies like Zitadel's), masterkey = exactly
   *  32 alnum chars, secret-key = 50 url-safe chars, token = 64 hex chars. */
  generate: "password" | "strong-password" | "masterkey" | "secret-key" | "token";
  /** When set, the secret is user-editable in the deploy form under this label
   *  (e.g. an admin password). Unlabeled secrets stay internal/auto-generated. */
  label?: string;
};

/** Maps a base-volume subdirectory into a specific compose service's data path. */
export type ServiceVolumeSubpath = {
  /** Compose service name (e.g. "postgresql"). */
  service: string;
  /** Subdirectory under the base volume mount (e.g. "database"). */
  subpath: string;
  /** Path inside that container the subdir is bound to (e.g. "/var/lib/postgresql/data"). */
  container: string;
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
  /** When true, expose this service via the panel ingress on a public domain (HTTP-facing). */
  http?: boolean;
  /** Brief description shown in the UI. */
  description?: string;
  /** Free-form category tag (e.g. "ai", "database", "search"). */
  category?: string;

  // --- Multi-container (compose-backed) services ---------------------------
  /** Filename of a bundled compose template under catalog/compose/. Presence of
   *  this field makes the service "compose-kind" instead of single-container. */
  compose?: string;
  /** Loaded text of the bundled compose template (populated by loadCatalog). */
  composeTemplate?: string;
  /** Which compose service the ingress proxies / health-checks (e.g. "server"). */
  composeWebService?: string;
  /** That service's internal HTTP port (e.g. 9000). */
  composeWebPort?: number;
  /** Generated secrets (beyond requiredEnvVars) written to the env file. */
  secrets?: ServiceSecretSpec[];
  /** Per-component bind mounts carved out of the single base volume. */
  volumeSubpaths?: ServiceVolumeSubpath[];
  /** Map of credential-field name -> env key to surface in the UI (e.g.
   *  { "admin_password": "AUTHENTIK_BOOTSTRAP_PASSWORD" }). */
  surfaceCredentials?: Record<string, string>;
  /** For compose services, inject the selected `version` into the env file
   *  under this key so the template can pin its image tag (e.g. "AUTHENTIK_TAG"). */
  versionEnvKey?: string;
  /** For HTTP services that must know their public hostname at startup (e.g.
   *  Zitadel's ZITADEL_EXTERNALDOMAIN), inject the resolved domain under this key. */
  domainEnvKey?: string;
  /** Server type to provision for this service (overrides the default when it
   *  needs more resources than a typical single container). */
  minServerType?: string;
  /** Advisory memory footprint (MB) used for UI warnings / sizing. */
  recommendedMemoryMb?: number;
};

function randomFromAlphabet(alphabet: string, len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function randomPassword(len = 24): string {
  return randomFromAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", len);
}

/** Password guaranteed to contain lower+upper+digit+symbol, for strict policies
 *  (e.g. Zitadel's first-admin). Symbol set excludes $ ' " ` \ to stay safe in
 *  env files and docker-compose ${VAR} interpolation. */
function strongPassword(len = 24): string {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digit = "0123456789";
  // Symbols safe in env files / ${VAR} interpolation: no $ ' " ` \ # =.
  const symbol = "!@%^*-_+.";
  const all = lower + upper + digit + symbol;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint8Array(1))[0] % set.length];
  const chars = [pick(lower), pick(upper), pick(digit), pick(symbol)];
  while (chars.length < len) chars.push(pick(all));
  // Fisher–Yates shuffle so the guaranteed chars aren't always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint8Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function generateSecret(kind: ServiceSecretSpec["generate"]): string {
  switch (kind) {
    case "password":
      return randomPassword();
    case "strong-password":
      return strongPassword();
    case "masterkey":
      // Zitadel requires a masterkey of exactly 32 bytes.
      return randomPassword(32);
    case "secret-key":
      // 50 url-safe chars — used for app signing keys (e.g. AUTHENTIK_SECRET_KEY).
      return randomFromAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_", 50);
    case "token":
      return randomFromAlphabet("0123456789abcdef", 64);
  }
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
  for (const s of def.secrets || []) {
    env[s.key] = generateSecret(s.generate);
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
    if (def.compose) {
      // Compose-kind services ship a bundled docker-compose template alongside
      // the JSON definition; load it eagerly so the engine has it in hand.
      def.composeTemplate = readFileSync(join(dir, "compose", def.compose), "utf8");
    }
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
