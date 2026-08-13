/**
 * Canonical, single-source-of-truth Zod schemas for deploy (`.ocd-deploy.json`)
 * and stack (`ocd-stack.json`) manifests. The TypeScript manifest *types* are
 * DERIVED from these schemas via `z.infer` (see the `DeployManifest` /
 * `StackManifest` re-exports in `./rpc.ts`) so the shape and the validator can
 * never drift — the drift that once let `"health_check": false` (a boolean)
 * slip past the types and break a deploy.
 *
 * Dependency-light (zod only) so it's safe to import from the compiled CLI
 * bundle. It imports nothing from `./rpc.ts` (that would be a cycle) or
 * `./validate.ts`; instead the numeric bounds/predicates that used to live in
 * `./validate.ts` now live HERE and `./validate.ts` re-exports them.
 *
 * The user-facing validators (`validateDeployManifest` / `validateStackManifest`
 * in `./manifest-validate.ts`) run these schemas with `safeParse` and map the
 * Zod issues onto field-level "expected … got …" messages.
 */
import { z } from "zod";

// --- numeric bounds + predicates (formerly in ./validate.ts) ----------------

/** Per-app container memory ceiling bounds (MB). 0 means "platform default". */
export const MIN_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 32768;

export function isValidMemoryMb(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 || (value >= MIN_MEMORY_MB && value <= MAX_MEMORY_MB))
  );
}

/** Per-app container CPU ceiling bounds (cores). 0 means "platform default".
 *  Fractional values are allowed (docker's --cpus flag), so we don't require an
 *  integer — only a finite value in range with sane precision. */
export const MIN_CPU_LIMIT = 0.1;
export const MAX_CPU_LIMIT = 32;

export function isValidCpuLimit(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value === 0) return true;
  // Reject nonsense precision (e.g. 0.333333) that docker would round oddly.
  if (Math.round(value * 100) !== value * 100) return false;
  return value >= MIN_CPU_LIMIT && value <= MAX_CPU_LIMIT;
}

/** Public-router rate limit in requests/second; 0 = unlimited. */
export function isValidRateLimitRps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- "got"/"jsonType" renderers (shared with manifest-validate.ts) ----------

/** JSON-ish type name, distinguishing arrays and null from "object". */
export function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | "undefined"
}

/** Human-readable "got" descriptor, e.g. `boolean (false)`, `"tpc"`, `number (3.5)`. */
export function got(v: unknown): string {
  const t = jsonType(v);
  if (t === "boolean" || t === "number") return `${t} (${String(v)})`;
  if (t === "string") return `"${String(v)}"`;
  return t;
}

// --- schema building blocks -------------------------------------------------

/**
 * A number field that fails with ONE unified "expected …" phrase whether the
 * value is the wrong type (Zod's built-in `invalid_type`, whose message the
 * validator suffixes with `, got …`) or the right type but out of range (our
 * refine, which renders the full `…, got …` message itself). Both routes yield
 * the same final wording, matching the old hand-written validator.
 */
function guardedNumber(phrase: string, ok: (v: number) => boolean) {
  return z
    .number({ error: phrase })
    .refine(ok, { error: (iss) => `${phrase}, got ${got(iss.input)}` });
}

/** A non-empty (after trim) string field with a unified "expected …" phrase. */
function nonEmptyString(phrase: string) {
  return z
    .string({ error: phrase })
    .refine((v) => v.trim().length > 0, {
      error: (iss) => `${phrase}, got ${got(iss.input)}`,
    });
}

// --- deploy manifest --------------------------------------------------------

/** Build config. Nested unknown keys are silently stripped (only TOP-LEVEL
 *  unknown keys warn), matching the old validator. */
const buildSchema = z.object(
  {
    dockerfile: z.string({ error: "expected string" }).optional(),
    context: z.string({ error: "expected string" }).optional(),
    container_port: guardedNumber(
      "expected integer 1-65535",
      (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
    ).optional(),
    /** Registry cache shared between build hosts via BuildKit. */
    cache_ref: nonEmptyString("expected an OCI registry cache reference").optional(),
  },
  { error: "expected object { dockerfile?, context?, container_port? }" },
);

const imageSchema = z.object({
  ref: z.string({ error: "expected immutable OCI image reference" }).refine(
    (value) => /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(value),
    { error: (iss) => `expected image@sha256:<64 hex digest>, got ${got(iss.input)}` },
  ),
}, { error: "expected object { ref }" }).strict();

/** One declared env var. `key` must be a valid env-var name. */
const envEntrySchema = z.object(
  {
    key: z
      .string({ error: "expected env-var-name string" })
      .refine((v) => ENV_KEY_PATTERN.test(v), {
        error: (iss) => `expected env-var-name string, got ${got(iss.input)}`,
      }),
    description: z.string({ error: "expected string" }).optional(),
    default: z.string({ error: "expected string" }).optional(),
    required: z.boolean({ error: "expected boolean" }).optional(),
    secret: z.boolean({ error: "expected boolean" }).optional(),
  },
  { error: 'expected object with a "key"' },
);

/** App data volume desired state. `id` adopts one exact retained/provider
 * volume; omitting it means OCD owns creation. Size is always explicit so the
 * reconciler can grow deterministically and reject impossible shrink requests. */
const volumeSchema = z.object(
  {
    id: nonEmptyString("expected a non-empty provider volume id").optional(),
    size: guardedNumber("expected positive integer", (v) => Number.isInteger(v) && v >= 1),
    path: z
      .string({ error: 'expected string starting with "/"' })
      .refine((v) => v.startsWith("/"), {
        error: (iss) => `expected string starting with "/", got ${got(iss.input)}`,
      })
      .optional(),
  },
  { error: "expected object { size, id?, path? }" },
);

/** Auto-deploy webhook config. `staging: true` holds each pushed commit in the
 *  `<name>-staging` sibling for manual promotion instead of redeploying
 *  production directly — it requires a staging environment to be selected at
 *  deploy time through `webhook.staging_environment`. */
const webhookPatternSchema = nonEmptyString("expected a non-empty repository-relative glob")
  .superRefine((value, ctx) => {
    if (value.startsWith("!")) {
      ctx.addIssue({ code: "custom", message: "inline !patterns are not supported; use webhook.paths_ignore" });
    }
    if (value.includes("\\")) {
      ctx.addIssue({ code: "custom", message: 'patterns must use "/", not "\\\\"' });
    }
    if (value.startsWith("/") || value.startsWith("./") || value.split("/").includes("..")) {
      ctx.addIssue({ code: "custom", message: "expected a repository-root-relative pattern" });
    }
  });

const webhookSchema = z.object(
  {
    enabled: z.boolean({ error: "expected boolean" }).optional(),
    branch: z.string({ error: "expected string" }).optional(),
    path: z.string({ error: "expected string" }).optional(),
    paths: z.array(webhookPatternSchema, {
      error: "expected a non-empty array of repository-relative glob patterns",
    }).min(1, { error: "expected at least one pattern" }).optional(),
    paths_ignore: z.array(webhookPatternSchema, {
      error: "expected an array of repository-relative glob patterns",
    }).optional(),
    wait_for_ci: z.boolean({ error: "expected boolean" }).optional(),
    staging: z.boolean({ error: "expected boolean" }).optional(),
    staging_environment: z.union([
      nonEmptyString("expected a non-empty environment name"),
      z.null(),
    ]).optional(),
  },
  { error: "expected object { enabled?, branch?, path?, paths?, paths_ignore?, wait_for_ci?, staging?, staging_environment? }" },
).superRefine((value, ctx) => {
  if (value.path !== undefined && value.paths !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "cannot be used together with webhook.paths",
      path: ["path"],
    });
  }
});

const autoscalingSchema = z.object({
  enabled: z.boolean({ error: "expected boolean" }).optional(),
  min_replicas: guardedNumber(
    "expected non-negative integer",
    (v) => Number.isInteger(v) && v >= 0,
  ).optional(),
  max_replicas: guardedNumber(
    "expected positive integer",
    (v) => Number.isInteger(v) && v >= 1,
  ).optional(),
  cpu_threshold: guardedNumber(
    "expected integer 1-100",
    (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  ).optional(),
  memory_threshold: guardedNumber(
    "expected integer 1-100",
    (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  ).optional(),
  requests_per_minute: guardedNumber(
    "expected non-negative integer",
    (v) => Number.isInteger(v) && v >= 0,
  ).optional(),
  cooldown_seconds: guardedNumber(
    "expected integer >= 30",
    (v) => Number.isInteger(v) && v >= 30,
  ).optional(),
}, { error: "expected autoscaling object" }).strict().superRefine((value, ctx) => {
  if (
    value.min_replicas !== undefined &&
    value.max_replicas !== undefined &&
    value.max_replicas < value.min_replicas
  ) {
    ctx.addIssue({
      code: "custom",
      message: "must be greater than or equal to min_replicas",
      path: ["max_replicas"],
    });
  }
});

/** Extra host→container bind mount. */
const extraVolumeSchema = z.object(
  {
    host_path: z.string({ error: "expected string" }),
    container_path: z.string({ error: "expected string" }),
  },
  { error: "expected object { host_path, container_path }" },
);

/**
 * HTTP health check. `enabled:false` skips the HTTP probe and only verifies the
 * container runs (default true). `path` is the endpoint both the post-deploy
 * probe and Traefik's rotation check request (default /; setting one also turns
 * on Traefik's continuous check). A path requires internal_protocol 'http'.
 *
 * NOTE: the object form `{ enabled?, path? }` is the ONLY form honored by the
 * mapping — a bare boolean (the original incident) is a hard error here.
 */
const healthCheckSchema = z.object(
  {
    enabled: z.boolean({ error: "expected boolean" }).optional(),
    path: z.string({ error: "expected string" }).optional(),
    /** Readiness contract. Omit for the legacy enabled/path behavior. */
    mode: z.enum(["http", "container", "exec", "heartbeat", "periodic_job"], {
      error: 'expected "http" | "container" | "exec" | "heartbeat" | "periodic_job"',
    }).optional(),
    /** Shell command executed inside the container for mode=exec. Exit 0=ready. */
    command: nonEmptyString("expected a non-empty string").optional(),
    /** Absolute timestamp-marker path for heartbeat/periodic_job modes. */
    file: z.string({ error: 'expected absolute path string' }).refine((v) => /^\/[A-Za-z0-9._/-]+$/.test(v), {
      error: (iss) => `expected absolute path string, got ${got(iss.input)}`,
    }).optional(),
    /** Maximum marker age before readiness fails. */
    max_age_seconds: guardedNumber(
      "expected positive integer",
      (v) => Number.isInteger(v) && v >= 1,
    ).optional(),
    /** Exact HTTP statuses accepted by readiness. Defaults to [200]. */
    expected_statuses: z.array(
      guardedNumber("expected integer HTTP status 100-599", (v) => Number.isInteger(v) && v >= 100 && v <= 599),
      { error: "expected array of HTTP status codes" },
    ).min(1, { error: "expected at least one HTTP status code" }).optional(),
  },
  { error: "expected health-check object" },
).superRefine((value, ctx) => {
  const mode = value.mode ?? (value.enabled === false ? "container" : "http");
  if (mode === "exec" && !value.command) {
    ctx.addIssue({ code: "custom", message: "required when mode is exec", path: ["command"] });
  }
  if ((mode === "heartbeat" || mode === "periodic_job") && !value.file) {
    ctx.addIssue({ code: "custom", message: `required when mode is ${mode}`, path: ["file"] });
  }
  if ((mode === "heartbeat" || mode === "periodic_job") && !value.max_age_seconds) {
    ctx.addIssue({ code: "custom", message: `required when mode is ${mode}`, path: ["max_age_seconds"] });
  }
  if (value.mode && mode !== "http" && value.path) {
    ctx.addIssue({ code: "custom", message: "only valid when mode is http", path: ["path"] });
  }
  if (mode !== "http" && value.expected_statuses) {
    ctx.addIssue({ code: "custom", message: "only valid when mode is http", path: ["expected_statuses"] });
  }
});

/**
 * HTTP basic-auth intent. Password material is deliberately never accepted
 * inline: it comes from a local process environment variable or a hidden CLI
 * prompt, so a deploy manifest remains safe to commit.
 */
const authSchema = z.object(
  {
    enabled: z.boolean({ error: "expected boolean" }),
    password_env: z
      .string({ error: "expected environment variable name string" })
      .refine((v) => ENV_KEY_PATTERN.test(v), {
        error: (iss) => `expected environment variable name string, got ${got(iss.input)}`,
      })
      .optional(),
  },
  { error: "expected object { enabled, password_env? }" },
).strict();

export const DeployManifestSchema = z
  .object({
    $schema: z.literal(1, { error: "expected 1" }).optional(),
    /** Recognized metadata for agent/tooling hints; ignored by the deploy engine. */
    $llm: z.unknown().optional(),
    name: nonEmptyString("expected a non-empty string"),
    description: z.string({ error: "expected string" }).optional(),
    icon: z.string({ error: "expected string" }).optional(),
    build: buildSchema.optional(),
    /** Prebuilt artifact mode: pull and run this exact immutable OCI digest. */
    image: imageSchema.optional(),
    env: z
      .array(envEntrySchema, {
        error: "expected array of { key, description?, default?, required?, secret? }",
      })
      .optional(),
    /** Existing environment selected by name; null explicitly detaches it. */
    environment: z.union([
      nonEmptyString("expected a non-empty environment name"),
      z.null(),
    ]).optional(),
    /** Required: null explicitly means no primary volume. */
    volume: z.union([volumeSchema, z.null()], {
      error: "expected null or object { size, id?, path? }",
    }),
    webhook: webhookSchema.optional(),
    suggested_app_name: z.string({ error: "expected string" }).optional(),
    /** Custom public domain. */
    domain: z.string({ error: "expected string" }).optional(),
    /** Source branch used for deploys. */
    git_branch: z.string({ error: "expected string" }).optional(),
    /** Limit a linked environment to selected keys. null/omit = all, [] = none. */
    env_projection: z.array(z.string({ error: "expected an environment key string" }), {
      error: "expected array of environment variable keys",
    }).optional(),
    auth: authSchema.optional(),
    replicas: guardedNumber(
      "expected positive integer",
      (v) => Number.isInteger(v) && v >= 1,
    ).optional(),
    autoscaling: autoscalingSchema.optional(),
    public: z.boolean({ error: "expected boolean" }).optional(),
    extra_volumes: z
      .array(extraVolumeSchema, {
        error: "expected array of { host_path, container_path }",
      })
      .optional(),
    /** Per-container memory ceiling in MB. Omit / 0 → platform default. */
    memory_mb: guardedNumber(
      `expected integer 0 (default) or ${MIN_MEMORY_MB}-${MAX_MEMORY_MB}`,
      isValidMemoryMb,
    ).optional(),
    /** Per-container CPU ceiling in cores (fractional allowed). Omit / 0 → platform default. */
    cpu_limit: guardedNumber(
      `expected 0 (default) or a number ${MIN_CPU_LIMIT}-${MAX_CPU_LIMIT}`,
      isValidCpuLimit,
    ).optional(),
    health_check: healthCheckSchema.optional(),
    /** Internal routing protocol (independent of health_check.enabled); omit → "http".
     *  Raw-TCP apps (e.g. databases) must set "tcp". */
    internal_protocol: z.enum(["http", "tcp"], { error: 'expected "http" | "tcp"' }).optional(),
    /** Sticky sessions (cookie-based) on the app's ingress service. */
    sticky: z.boolean({ error: "expected boolean" }).optional(),
    /** Public-router rate limit in req/s; omit / 0 = unlimited. */
    rate_limit_rps: guardedNumber(
      "expected integer 0 (unlimited) to 1000000",
      isValidRateLimitRps,
    ).optional(),
    /** Comma-separated IPs/CIDRs gating the public router; omit / "" = open. */
    ip_allowlist: z.string({ error: "expected string" }).optional(),
    /** Response compression on the public router. */
    compress: z.boolean({ error: "expected boolean" }).optional(),
    /** Public raw TCP/UDP exposure: "auto" = lowest free pool port, number = specific pool port, omit = none. */
    public_port: z
      .union([z.number().int(), z.literal("auto"), z.null()], {
        error: 'expected integer, "auto", or null',
      })
      .optional(),
    /** Pool for public_port (default "tcp"). */
    public_protocol: z.enum(["tcp", "udp"], { error: 'expected "tcp" | "udp"' }).optional(),
    /** Availability/durability policy: 'none' (default), 'standard', or 'high'.
     *  Maps to concrete placement-spread + min-replica floors at deploy time. */
    durability_class: z
      .enum(["none", "standard", "high"], { error: 'expected "none" | "standard" | "high"' })
      .optional(),
    /** Placement pool used by the scheduler. */
    placement_pool: nonEmptyString("expected a non-empty string").optional(),
    /** Idle seconds before a deploy target may scale to zero. 0 means no delay. */
    scale_to_zero_after: guardedNumber(
      "expected non-negative integer",
      (v) => Number.isInteger(v) && v >= 0,
    ).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.image && (value.build?.dockerfile || value.build?.context || value.build?.cache_ref)) {
      ctx.addIssue({
        code: "custom",
        message: "prebuilt image mode cannot also configure source-build dockerfile, context, or cache_ref",
        path: ["image"],
      });
    }
    if (
      value.autoscaling?.max_replicas !== undefined &&
      value.replicas !== undefined &&
      value.autoscaling.max_replicas < value.replicas
    ) {
      ctx.addIssue({
        code: "custom",
        message: "must be greater than or equal to replicas",
        path: ["autoscaling", "max_replicas"],
      });
    }
    if (
      value.webhook?.staging_environment != null &&
      value.webhook.enabled !== true
    ) {
      ctx.addIssue({
        code: "custom",
        message: "requires webhook.enabled to be true",
        path: ["webhook", "staging_environment"],
      });
    }
  });

export type DeployManifest = z.infer<typeof DeployManifestSchema>;

// --- stack manifest ---------------------------------------------------------

/** One managed service member (catalog type + options). */
const stackServiceSchema = z
  .object({
    type: nonEmptyString("expected a non-empty string"),
    version: z.string({ error: "expected string" }).optional(),
    volume_size: guardedNumber("expected positive number", (v) => v >= 1).optional(),
    env_overrides: z
      .record(z.string(), z.string(), { error: "expected object map of string -> string" })
      .optional(),
    /** Custom domain for HTTP-facing catalog services. */
    domain: z.string({ error: "expected string" }).optional(),
    /** Optional settings for the automatically-created isolated staging
     * counterpart. Omitted fields inherit the production declaration. */
    staging: z.object({
      volume_size: guardedNumber("expected positive number", (v) => v >= 1).optional(),
      env_overrides: z
        .record(z.string(), z.string(), { error: "expected object map of string -> string" })
        .optional(),
      domain: z.string({ error: "expected string" }).optional(),
    }, { error: "expected object { volume_size?, env_overrides?, domain? }" }).strict().optional(),
  }, { error: "expected object { type, version?, volume_size?, env_overrides?, domain?, staging? }" })
  .strict();

/** One app member: a path to a child `.ocd-deploy.json` + stack-level overrides. */
const stackAppSchema = z
  .object({
    manifest: nonEmptyString("expected a manifest path string"),
    needs: z
      .array(z.string({ error: "expected a key string" }), {
        error: "expected array of app/service keys",
      })
      .optional(),
    domain: z.string({ error: "expected string" }).optional(),
    public: z.boolean({ error: "expected boolean" }).optional(),
    /** Keys this member receives from the shared stack environment. Omit to
     *  derive least privilege from the child manifest and declared needs. */
    env: z.array(z.string({ error: "expected an environment key string" }), {
      error: "expected array of environment variable keys",
    }).optional(),
    /** Explicitly opt this member into the complete shared environment. */
    env_all: z.boolean({ error: "expected boolean" }).optional(),
  }, { error: "expected object { manifest, needs?, domain?, public?, env?, env_all? }" })
  .strict()
  .superRefine((value, ctx) => {
    if (value.env !== undefined && value.env_all) {
      ctx.addIssue({
        code: "custom",
        message: "cannot be combined with env; choose an explicit key list or env_all",
        path: ["env_all"],
      });
    }
  });

export const StackManifestSchema = z
  .object({
    $schema: z.literal(1, { error: "expected 1" }).optional(),
    /** Recognized metadata for agent/tooling hints; ignored by the deploy engine. */
    $llm: z.unknown().optional(),
    name: nonEmptyString("expected a non-empty string"),
    description: z.string({ error: "expected string" }).optional(),
    /** Existing shared production environment selected by name. */
    environment: nonEmptyString("expected a non-empty environment name").optional(),
    /** Existing shared staging environment selected by name; null disables it. */
    staging_environment: z.union([
      nonEmptyString("expected a non-empty environment name"),
      z.null(),
    ]).optional(),
    /** Desired overrides applied after the staging environment is
     * created/copied. Secret values are supplied by the CLI, not stored here. */
    staging_env: z.array(envEntrySchema, { error: "expected array of environment variable definitions" }).optional(),
    services: z
      .record(z.string(), stackServiceSchema, { error: "expected object map of key -> service" })
      .optional(),
    apps: z.record(z.string(), stackAppSchema, { error: "expected object map of key -> app" }),
  })
  .strict()
  .superRefine((val, ctx) => {
    // apps must be non-empty.
    const appKeys = Object.keys(val.apps ?? {});
    if (appKeys.length === 0) {
      ctx.addIssue({ code: "custom", message: "expected at least one app", path: ["apps"] });
    }
    // Cross-field: every `needs` entry must name a declared app or service key.
    const known = new Set([...appKeys, ...Object.keys(val.services ?? {})]);
    for (const [key, app] of Object.entries(val.apps ?? {})) {
      const needs = app.needs ?? [];
      for (let i = 0; i < needs.length; i++) {
        const n = needs[i];
        if (!known.has(n)) {
          ctx.addIssue({
            code: "custom",
            message: `references "${n}", which is not a declared app or service key`,
            path: ["apps", key, "needs", i],
          });
        }
      }
    }
  });

export type StackManifest = z.infer<typeof StackManifestSchema>;
