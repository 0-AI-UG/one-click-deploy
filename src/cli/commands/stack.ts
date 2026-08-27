import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { get, post, del } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";
import { webConfirm, withWebConfirmation } from "../confirm.ts";
import {
  manifestRepoLocation,
  readManifest,
  promptRequired,
  resolveAuthPassword,
  manifestHash,
} from "../manifest.ts";
import {
  mergeEnv,
  type AppEnvDefs,
  type EnvDef,
  type MergedEntry,
  type RequiredMissing,
} from "../../shared/env-merge.ts";
import { buildStackAppSpec } from "../../shared/stack-spec.ts";
import { validateStackManifest } from "../../shared/manifest-validate.ts";
import type { StackManifest, StackDeployRequest } from "../../shared/rpc.ts";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";
import { operationLogQuery, parseLogArgs } from "../log-filters.ts";
import { expectArray, expectRecord, expectStringField } from "../response.ts";

type AppElement = StackDeployRequest["apps"][number];

/** Pure manifest→wire mapping kept exported for parity regression tests. */
export function buildStackServiceSpecs(
  manifest: StackManifest,
): StackDeployRequest["services"] {
  return Object.entries(manifest.services || {}).map(([key, svc]) => ({
    key,
    type: svc.type,
    version: svc.version,
    volume_size: svc.volume_size,
    env_overrides: svc.env_overrides,
    domain: svc.domain,
    staging: svc.staging,
    needs: undefined,
  }));
}

interface StackListItem {
  id: number;
  name: string;
  status: string;
  created_at: string;
  app_count: number;
  service_count: number;
  environment_id?: number | null;
  /** The stack's shared staging environment, remembered across re-ups. */
  staging_environment_id?: number | null;
  staging_env_keys?: string;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
  last_operation_children?: Array<{ id: number; kind: string; status: string }>;
}

async function fetchStackList(): Promise<StackListItem[]> {
  const values = expectArray(await get<unknown>("/api/stacks"), "Stacks request");
  for (const [index, value] of values.entries()) {
    const row = expectRecord(value, `Stacks request item ${index + 1}`);
    if (!Number.isInteger(row.id) || typeof row.name !== "string" || typeof row.status !== "string") {
      throw new Error(`Stacks request returned a malformed response (invalid stack at index ${index})`);
    }
  }
  return values as StackListItem[];
}

interface StackDetail {
  id: number;
  name: string;
  status: string;
  created_at: string;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
  last_operation_children?: Array<{ id: number; kind: string; status: string }>;
  resource_status_reason?: string;
  apps: Array<{ id: number; name: string; status: string; domain: string; public?: number | boolean; environment_stale?: number | boolean }>;
  services: Array<{ id: number; name: string; service_type: string; version: string; status: string }>;
  public_endpoints?: Array<{
    app_name: string; domain: string; managed: boolean; expectedTarget: string;
    resolved: string[]; ready: boolean; tlsReady: boolean; httpStatus?: number; tlsError?: string;
  }>;
  acme_errors?: string[];
}

function readStackManifest(path: string, options: { allowUnknown?: boolean } = {}): StackManifest {
  let manifest: StackManifest;
  try {
    const raw = readFileSync(path, "utf-8");
    manifest = JSON.parse(raw) as StackManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${RED}Stack manifest not found: ${path}${RESET}`);
    } else {
      console.error(`${RED}Failed to read stack manifest: ${err instanceof Error ? err.message : err}${RESET}`);
    }
    process.exit(1);
  }
  try {
    validateStackManifest(manifest, path, options);
  } catch (err) {
    console.error(`${RED}${err instanceof Error ? err.message : err}${RESET}`);
    process.exit(1);
  }
  return manifest;
}

/**
 * Build a stack app element from its DeployManifest via the shared mapping
 * (src/shared/stack-spec.ts), then attach the CLI-collected env vars.
 */
function buildAppElement(
  key: string,
  entry: StackManifest["apps"][string],
  manifest: ReturnType<typeof readManifest>,
  envVars: Array<{ key: string; value: string; secret?: boolean }>,
  manifestPath: string,
  manifestFullPath: string,
): AppElement {
  const el = buildStackAppSpec(key, entry, manifest, "", "");
  el.manifest_path = manifestPath;
  el.manifest_hash = manifestHash(manifestFullPath);
  if (envVars.length > 0) el.env_vars = envVars;
  return el;
}

/** Non-exiting lookup — returns undefined instead of exiting when no stack row
 *  matches, so callers (e.g. stack logs) can fall back to op history. */
async function lookupStack(name: string): Promise<StackListItem | undefined> {
  const list = await fetchStackList();

  // All-digit only: `parseInt("3rd-party")` is 3, which would resolve a
  // digit-leading stack name to an unrelated stack id — and `ocd delete stack`
  // destroys whatever this returns. Names may start with a digit.
  if (/^\d+$/.test(name)) {
    const id = parseInt(name, 10);
    const byId = list.find((s) => s.id === id);
    if (byId) return byId;
  }

  const lower = name.toLowerCase();
  return list.find((s) => s.name.toLowerCase() === lower);
}

async function resolveStack(name: string): Promise<StackListItem> {
  const found = await lookupStack(name);
  if (found) return found;

  const list = await fetchStackList();
  console.error(`Stack not found: ${name}`);
  console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function upUsage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd deploy stack [manifest] [options]

Deploys a multi-app stack from an ocd-stack.json manifest. Each app entry
references a .ocd-deploy.json (resolved relative to the stack manifest). All
apps deploy from the exact immutable OCI digests in their manifests.

Env vars are collected per app from each app's manifest env[] section:
defaults are sent as-is, --set overrides or adds values, and required vars
without a value are prompted for (grouped per app).

${BOLD}Arguments:${RESET}
  [manifest]                 Path to stack manifest (default: ocd-stack.json)

${BOLD}Options:${RESET}
  --set=<app>.KEY=VALUE      Set an env var for one app (repeatable)
  --set=KEY=VALUE            Set an env var for all apps as a fallback
  --staging-set=KEY=VALUE    Set a staging-only env var (repeatable)
  --only=web,worker          Reconcile only these app members
  --with-dependents          Include downstream app dependents of --only
  --changed                  Reconcile members whose manifest or image changed
  --all                      Reconcile every member (disables changed-only default)
  --config-only              Apply config without changing the image; runtime changes
                             reuse the current immutable images
  --allow-unknown            Compatibility escape hatch for newer manifest keys

Select shared production and staging environments with the stack manifest's
\`environment\` and \`staging_environment\` fields.`);
}

export function expandAppDependents(
  selected: Iterable<string>,
  apps: StackManifest["apps"],
): Set<string> {
  const out = new Set(selected);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, app] of Object.entries(apps)) {
      if (out.has(key)) continue;
      if ((app.needs ?? []).some((dependency) => out.has(dependency))) {
        out.add(key);
        grew = true;
      }
    }
  }
  return out;
}

function clientVisibleConfigDiff(existing: Record<string, unknown>, desired: AppElement): string[] {
  const desiredValues: Record<string, unknown> = {
    image_ref: desired.image_ref ?? "",
    container_port: desired.container_port,
    public: desired.public ?? true,
    memory_mb: desired.memory_mb ?? 0,
    cpu_limit: desired.cpu_limit ?? 0,
    health_check_mode: desired.health_check_mode ?? (desired.health_check === false ? "container" : "http"),
    health_check_path: desired.health_check_path ?? "",
    health_check_command: desired.health_check_command ?? "",
    health_check_file: desired.health_check_file ?? "",
    health_check_max_age_seconds: desired.health_check_max_age_seconds ?? 0,
    internal_protocol: desired.internal_protocol ?? "http",
    sticky: desired.sticky ?? false,
    rate_limit_rps: desired.rate_limit_rps ?? 0,
    ip_allowlist: desired.ip_allowlist ?? "",
    compress: desired.compress ?? false,
    public_port: desired.public_port ?? null,
    public_protocol: desired.public_protocol ?? "tcp",
    placement_pool: desired.placement_pool ?? "general",
    scale_to_zero_after: desired.scale_to_zero_after ?? 0,
    desired_replicas: desired.replicas ?? 1,
    min_replicas: desired.min_replicas ?? 1,
    max_replicas: desired.max_replicas ?? Math.max(desired.replicas ?? 1, desired.min_replicas ?? 1),
    autoscale_enabled: desired.autoscale_enabled ?? false,
    desired_volume_id: desired.volume_id ?? "",
    desired_volume_size: desired.volume_size ?? 0,
    desired_volume_path: desired.volume_path ?? "/data",
  };
  const booleanFields = new Set([
    "public", "sticky", "compress", "autoscale_enabled",
  ]);
  const changed: string[] = [];
  for (const [field, wanted] of Object.entries(desiredValues)) {
    let actual = existing[field];
    if (booleanFields.has(field)) actual = Boolean(actual);
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) changed.push(field);
  }
  return changed;
}

const LOCAL_RUNTIME_FIELDS = new Set([
  "container_port", "memory_mb", "cpu_limit", "health_check_mode",
  "health_check_command", "health_check_file", "health_check_max_age_seconds",
  "internal_protocol", "desired_volume_id", "desired_volume_size", "desired_volume_path",
]);

export function classifyLocalStackReconcile(
  existing: Record<string, unknown> | undefined,
  desired: AppElement,
  _changedFiles?: string[] | null,
  _stackManifestPath?: string,
  _otherManifestPaths: string[] = [],
): "control" | "runtime" | "artifact" {
  if (!existing) return "artifact";
  const changed = clientVisibleConfigDiff(existing, desired);
  if (changed.includes("image_ref")) return "artifact";
  return changed.some((field) => LOCAL_RUNTIME_FIELDS.has(field)) ? "runtime" : "control";
}

type ResolvedEnv = { id: number; name: string; env_vars?: Array<{ key: string }> };

async function resolveEnvironment(nameOrId: string): Promise<ResolvedEnv> {
  const list = await get<ResolvedEnv[]>("/api/environments");
  // All-digit only: `parseInt("3rd-party")` is 3, which would resolve an
  // environment named with a leading digit to an unrelated environment id.
  const byId = /^\d+$/.test(nameOrId) ? list.find((e) => e.id === parseInt(nameOrId, 10)) : undefined;
  if (byId) return byId;
  const lower = nameOrId.toLowerCase();
  const byName = list.find((e) => e.name.toLowerCase() === lower);
  if (byName) return byName;
  console.error(`${RED}Environment not found: ${nameOrId}${RESET}`);
  console.error(`Available: ${list.map((e) => e.name).join(", ") || "(none)"}`);
  process.exit(1);
}

/** The already-created stack row for this manifest (the server remembers its
 *  linked environment and staging environment across re-ups), or undefined when
 *  the stack doesn't exist yet. */
async function findStackByName(name: string): Promise<StackListItem | undefined> {
  const list = await fetchStackList();
  const lower = name.toLowerCase();
  return list.find((s) => s.name.toLowerCase() === lower);
}

async function findEnvironmentById(id: number): Promise<ResolvedEnv | undefined> {
  const list = await get<ResolvedEnv[]>("/api/environments");
  return list.find((e) => e.id === id);
}

/** Only keys previously written through stack staging_env may satisfy a
 * required declaration from an existing environment. A copied production key
 * with the same name is not evidence of staging configuration. */
export function certifiedStagingExistingKeys(
  env: ResolvedEnv | undefined,
  encodedCertifiedKeys: string | undefined,
): Set<string> {
  let certified: string[] = [];
  try {
    const parsed = JSON.parse(encodedCertifiedKeys || "[]");
    if (Array.isArray(parsed)) certified = parsed.map(String);
  } catch { /* invalid legacy state certifies nothing */ }
  const present = new Set((env?.env_vars || []).map((entry) => entry.key));
  return new Set(certified.filter((key) => present.has(key)));
}

/** Staging declarations are desired overrides, not production-style defaults:
 * an explicit default (including the empty string) must replace a value copied
 * from production. A required value without a default is satisfied only by a
 * key previously certified as explicitly staging-owned. */
export function mergeStagingEnv(
  defs: EnvDef[],
  overrides: Record<string, string>,
  certifiedExistingKeys: Set<string>,
): { entries: MergedEntry[]; requiredMissing: RequiredMissing[] } {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const keys = new Set([...byKey.keys(), ...Object.keys(overrides)]);
  const entries: MergedEntry[] = [];
  const requiredMissing: RequiredMissing[] = [];
  for (const key of [...keys].sort()) {
    const def = byKey.get(key);
    const secret = def?.secret === true;
    if (Object.hasOwn(overrides, key)) {
      entries.push({ key, value: overrides[key], secret });
    } else if (def?.default !== undefined) {
      // Empty is meaningful here: it clears a copied production credential or
      // side-effect URL in a checked-in, reviewable staging contract.
      entries.push({ key, value: def.default, secret });
    } else if (certifiedExistingKeys.has(key)) {
      continue;
    } else if (def?.required) {
      requiredMissing.push({
        key,
        apps: ["staging"],
        secret,
        description: def.description,
      });
    }
  }
  return { entries, requiredMissing };
}

export async function stackUp(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    help: { type: "boolean", aliases: ["h"] },
    set: { type: "string", repeatable: true },
    "staging-set": { type: "string", repeatable: true },
    only: { type: "string" },
    "with-dependents": { type: "boolean" },
    changed: { type: "boolean" },
    all: { type: "boolean" },
    "config-only": { type: "boolean" },
    "allow-unknown": { type: "boolean" },
  }, { maxPositionals: 1 });
  if (parsed.flags.help === true) {
    upUsage();
    process.exit(0);
  }
  const manifestPath = parsed.positionals[0] || "ocd-stack.json";
  const rawSets = (parsed.flags.set as string[] | undefined) ?? [];
  const rawStagingSets = (parsed.flags["staging-set"] as string[] | undefined) ?? [];
  const onlyRaw = (parsed.flags.only as string | undefined) ?? "";
  const withDependents = parsed.flags["with-dependents"] === true;
  const changedOnly = parsed.flags.changed === true;
  const forceAll = parsed.flags.all === true;
  const configOnly = parsed.flags["config-only"] === true;
  const allowUnknown = parsed.flags["allow-unknown"] === true;

  const stackLocation = manifestRepoLocation(manifestPath);
  const manifestFullPath = stackLocation.fullPath;
  const manifest = readStackManifest(manifestFullPath, { allowUnknown });
  const baseDir = dirname(manifestFullPath);

  if (!manifest.name) {
    console.error(`${RED}Stack manifest is missing a "name"${RESET}`);
    process.exit(1);
  }
  if (!manifest.apps || Object.keys(manifest.apps).length === 0) {
    console.error(`${RED}Stack manifest has no apps${RESET}`);
    process.exit(1);
  }

  const appKeys = new Set(Object.keys(manifest.apps));

  // Parse --set into per-app (<app>.KEY) and global (KEY) buckets. A plain
  // KEY is a fallback applied to any app that declares it; an <app>.KEY targets
  // that one app.
  const globalSets: Record<string, string> = {};
  const appSets: Record<string, Record<string, string>> = {};
  for (const pair of rawSets) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(`${RED}Invalid --set value (expected --set=KEY=VALUE or --set=app.KEY=VALUE): ${pair}${RESET}`);
      process.exit(1);
    }
    const lhs = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const dot = lhs.indexOf(".");
    if (dot > 0 && appKeys.has(lhs.slice(0, dot))) {
      const ak = lhs.slice(0, dot);
      const key = lhs.slice(dot + 1);
      (appSets[ak] ||= {})[key] = value;
    } else {
      globalSets[lhs] = value;
    }
  }

  console.log(`${DIM}Stack:${RESET} ${stackLocation.path} ${BOLD}(${manifest.name})${RESET}`);

  // Managed services
  const services = buildStackServiceSpecs(manifest);

  // Apps. Members share one environment, so env vars are merged across all
  // apps (not collected per-app) into a single stack env.
  const apps: AppElement[] = [];
  const appEnvDefs: AppEnvDefs[] = [];
  for (const [key, entry] of Object.entries(manifest.apps)) {
    const appManifest = readManifest(resolve(baseDir, entry.manifest), { allowUnknown });
    appEnvDefs.push({ app: key, defs: appManifest.env || [] });
    const childManifestPath = resolve(baseDir, entry.manifest);
    const appElement = buildAppElement(
      key,
      entry,
      appManifest,
      [],
      entry.manifest,
      childManifestPath,
    );
    const authPassword = await resolveAuthPassword(appManifest.auth);
    if (authPassword !== undefined) appElement.auth_password = authPassword;
    apps.push(appElement);
  }

  // Resolve the target environment (reused or, if omitted, auto-created) so we
  // know which keys already exist — existing values win over manifest defaults.
  const existingStack = await findStackByName(manifest.name);
  let reused = manifest.environment ? await resolveEnvironment(manifest.environment) : undefined;
  let resumed = false;
  // Resume: an already-created stack stays linked to its environment
  // server-side, so when environment is omitted we seed existing keys from that env —
  // otherwise a re-up re-prompts for (and re-requires) vars already stored.
  if (!reused && existingStack?.environment_id != null) {
    reused = await findEnvironmentById(existingStack.environment_id);
    resumed = !!reused;
  }
  const existingKeys = new Set((reused?.env_vars || []).map((v) => v.key));

  // --- staging environment -------------------------------------------------
  // Staging is an independent environment contract. Releases into staging are
  // initiated explicitly by CI or a user and can later be promoted by digest.
  //
  // Leave undefined when the field is absent — the deploy op then preserves the
  // stack's stored staging env. Only an explicit null sends null.
  let stagingEnvId: number | null | undefined;
  let stagingEnvName: string | undefined;
  let resolvedStagingEnv: ResolvedEnv | undefined;
  if (manifest.staging_environment === null) {
    stagingEnvId = null;
  } else if (manifest.staging_environment !== undefined) {
    const env = await resolveEnvironment(manifest.staging_environment);
    stagingEnvId = env.id;
    stagingEnvName = env.name;
    resolvedStagingEnv = env;
  } else if (existingStack?.staging_environment_id != null) {
    resolvedStagingEnv = await findEnvironmentById(existingStack.staging_environment_id);
  }

  const stagingOverrides: Record<string, string> = {};
  for (const pair of rawStagingSets) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(`${RED}Invalid --staging-set value (expected --staging-set=KEY=VALUE): ${pair}${RESET}`);
      process.exit(1);
    }
    stagingOverrides[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const wantsStaging = manifest.staging_environment !== undefined ||
    existingStack?.staging_environment_id != null ||
    (manifest.staging_env?.length ?? 0) > 0 ||
    rawStagingSets.length > 0;
  let staging_env_vars: Array<{ key: string; value: string; secret?: boolean }> = [];
  if (wantsStaging) {
    const mergedStaging = mergeStagingEnv(
      manifest.staging_env || [],
      stagingOverrides,
      certifiedStagingExistingKeys(resolvedStagingEnv, existingStack?.staging_env_keys),
    );
    const promptedStaging = await promptRequired(
      mergedStaging.requiredMissing,
      "Required environment variables (staging)",
    );
    staging_env_vars = [...mergedStaging.entries, ...promptedStaging];
  }

  // --set overrides target the shared env; app-scoped (`app.KEY`) and global
  // (`KEY`) both resolve to one key here, app-scoped last so it wins.
  const overrides: Record<string, string> = { ...globalSets };
  for (const perApp of Object.values(appSets)) Object.assign(overrides, perApp);

  const merged = mergeEnv(appEnvDefs, overrides, existingKeys);
  if (merged.conflicts.length > 0) {
    console.error(`\n${RED}Env var conflicts — apps disagree on a default and nothing resolves it:${RESET}`);
    for (const c of merged.conflicts) {
      console.error(`  ${BOLD}${c.key}${RESET}: ${c.apps.join(", ")} disagree — values: ${c.values.join(" | ")}`);
    }
    console.error(`Resolve with --set=${merged.conflicts[0].key}=VALUE or an existing environment.`);
    process.exit(1);
  }
  const prompted = await promptRequired(merged.requiredMissing, "Required environment variables (stack)");
  const env_vars = [...merged.entries, ...prompted];

  const body: StackDeployRequest = {
    name: manifest.name,
    stack_manifest_path: stackLocation.path,
    environment_id: reused?.id,
    staging_environment_id: stagingEnvId,
    env_vars: env_vars.length > 0 ? env_vars : undefined,
    staging_env_vars: staging_env_vars.length > 0 ? staging_env_vars : undefined,
    staging_env_keys: [
      ...new Set([
        ...(manifest.staging_env || []).map((entry) => entry.key),
        ...Object.keys(stagingOverrides),
      ]),
    ],
    services,
    apps,
  };

  const existingApps = await get<Array<{
    id: number;
    name: string;
    status: string;
    image_ref?: string | null;
    config_revision?: number;
    last_manifest_hash?: string | null;
    [key: string]: unknown;
  }>>("/api/apps");
  const allKeys = new Set(Object.keys(manifest.apps));
  let selectedKeys = new Set(allKeys);
  const modes = new Map<string, "control" | "runtime" | "artifact">();
  let selectionReason = "all members";
  if (onlyRaw) {
    selectedKeys = new Set(onlyRaw.split(",").map((key) => key.trim()).filter(Boolean));
    const unknown = [...selectedKeys].filter((key) => !allKeys.has(key));
    if (unknown.length) {
      console.error(`${RED}Unknown --only app member(s): ${unknown.join(", ")}${RESET}`);
      process.exit(1);
    }
    if (withDependents) selectedKeys = expandAppDependents(selectedKeys, manifest.apps);
    for (const key of selectedKeys) modes.set(key, "artifact");
    selectionReason = `explicit --only${withDependents ? " plus dependents" : ""}`;
  } else if (!forceAll && (changedOnly || existingStack)) {
    selectedKeys = new Set<string>();
    for (const app of apps) {
      const deployed = existingApps.find((candidate) => candidate.name === `${manifest.name}-${app.key}`);
      if (!deployed) {
        selectedKeys.add(app.key);
        modes.set(app.key, "artifact");
        continue;
      }
      const mode = classifyLocalStackReconcile(
        deployed,
        app,
      );
      if (
        deployed.last_manifest_hash !== app.manifest_hash ||
        mode === "artifact" ||
        clientVisibleConfigDiff(deployed, app).length > 0
      ) {
        selectedKeys.add(app.key);
        modes.set(app.key, mode);
      }
    }
    const direct = new Set(selectedKeys);
    selectedKeys = expandAppDependents(selectedKeys, manifest.apps);
    for (const key of selectedKeys) {
      if (!direct.has(key)) modes.set(key, "runtime");
    }
    if (rawSets.length > 0) {
      selectedKeys = expandAppDependents(allKeys, manifest.apps);
      for (const key of selectedKeys) modes.set(key, "runtime");
    }
    if (rawStagingSets.length > 0) {
      for (const app of apps) {
        selectedKeys.add(app.key);
        modes.set(app.key, "control");
      }
    }
    selectionReason = "changed manifests or immutable images plus dependents";
  }

  for (const app of apps) {
    if (!selectedKeys.has(app.key)) continue;
    const existing = existingApps.find((candidate) => candidate.name === `${manifest.name}-${app.key}`);
    app.reconcile_mode = existing ? modes.get(app.key) ?? "artifact" : "artifact";
  }
  if (configOnly) {
    const missing = apps.filter((app) => selectedKeys.has(app.key) &&
      !existingApps.some((candidate) => candidate.name === `${manifest.name}-${app.key}`));
    if (missing.length) {
      console.error(`${RED}Cannot use --config-only: stack members do not exist: ${missing.map((app) => app.key).join(", ")}${RESET}`);
      process.exit(1);
    }
  }

  const partial = selectedKeys.size < allKeys.size;
  body.selected_app_keys = [...selectedKeys].sort();
  body.partial = partial;
  body.config_only = configOnly;
  // Catalog services are cheap to reconcile and their desired state lives in
  // this manifest, so include them without relying on local Git history.
  body.selected_service_keys = services.map((service) => service.key);

  const levels = (() => {
    const remaining = new Set(selectedKeys);
    const out: string[][] = [];
    while (remaining.size) {
      const level = [...remaining].filter((key) =>
        (manifest.apps[key].needs ?? []).every((dep) => !remaining.has(dep))
      ).sort();
      if (!level.length) break;
      level.forEach((key) => remaining.delete(key));
      out.push(level);
    }
    return out;
  })();
  console.log(`\n${BOLD}Preflight plan${RESET}`);
  console.log(`${DIM}Artifacts:${RESET} immutable image digests from member manifests`);
  console.log(`${DIM}Selection:${RESET}     ${selectionReason}`);
  console.log(`${DIM}Order:${RESET}         ${levels.map((level) => level.join(" + ")).join(" → ") || "(no app rollout)"}`);
  table(
    ["MEMBER", "ACTION", "CONFIG DIFF", "MANIFEST", "IMAGE"],
    apps.map((app) => {
      const existing = existingApps.find((candidate) => candidate.name === `${manifest.name}-${app.key}`);
      const configDiff = !existing
        ? "new app"
        : clientVisibleConfigDiff(existing, app).join(", ") || "none";
      return [
        app.key,
        selectedKeys.has(app.key) ? (existing ? app.reconcile_mode || "reconcile" : "create") : "retain",
        configDiff,
        app.manifest_path || "-",
        app.image_ref || "-",
      ];
    }),
  );

  if (selectedKeys.size === 0 && body.selected_service_keys.length === 0) {
    console.log(`\n${GREEN}Stack already converged with the current manifests and image digests; nothing to deploy.${RESET}`);
    return;
  }

  console.log(
    `\nDeploying stack ${BOLD}${manifest.name}${RESET} (${body.selected_service_keys.length} affected service(s), ${selectedKeys.size} affected app(s))...`,
  );
  if (reused) {
    console.log(
      `${DIM}Env:${RESET}   reusing ${resumed ? "linked" : ""} environment ${reused.name}`.replace("  ", " "),
    );
  }
  if (stagingEnvName) console.log(`${DIM}Staging:${RESET} ${stagingEnvName}`);
  else if (stagingEnvId === null) console.log(`${DIM}Staging:${RESET} (cleared)`);

  const { op_id, attached } = await withWebConfirmation((headers) =>
    post<{ op_id: number; attached?: boolean }>("/api/stacks", body, headers)
  );
  if (attached) {
    console.log(
      `\n${DIM}A deploy of ${manifest.name} is already in progress — attaching to op #${op_id}…${RESET}`,
    );
  }
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack deploy complete!${RESET}`);
    const convergedApps = await get<Array<{
      name: string;
      status: string;
      image_ref?: string | null;
      config_revision?: number;
      environment_stale?: number | boolean;
    }>>("/api/apps");
    console.log(`\n${BOLD}Image convergence${RESET}`);
    table(
      ["MEMBER", "EXPECTED", "ACTUAL", "STATUS", "HEALTH", "CONFIG"],
      apps.map((app) => {
        const actual = convergedApps.find((candidate) => candidate.name === `${manifest.name}-${app.key}`);
        const expected = app.image_ref || "-";
        const actualImage = actual?.image_ref || "-";
        return [
          app.key,
          expected.split("@sha256:").pop()?.slice(0, 12) || "-",
          actualImage.split("@sha256:").pop()?.slice(0, 12) || "-",
          actual?.status || "missing",
          actual?.status === "running" && !actual.environment_stale ? "ready" : "not ready",
          actual?.config_revision != null ? `r${actual.config_revision}` : "-",
        ];
      }),
    );
  } else {
    console.error(`\n${RED}Stack deploy failed: ${result.error || "unknown error"}${RESET}`);
    console.error(
      `${DIM}Check progress with:${RESET} ocd stack logs ${manifest.name}   ${DIM}·${RESET}   ocd stack ls`,
    );
    process.exit(1);
  }
}

async function stackLs(): Promise<void> {
  const list = await fetchStackList();
  table(
    ["NAME", "STATUS", "LAST OP", "APPS", "SERVICES", "CREATED"],
    list.map((s) => [
      s.name,
      colorStatus(s.status),
      s.last_operation_id
        ? `#${s.last_operation_id} ${s.last_operation_status}${s.last_operation_failed ? " (failed)" : ""}`
        : "-",
      String(s.app_count),
      String(s.service_count),
      (s.created_at || "").replace("T", " ").slice(0, 16),
    ]),
  );
}

async function stackStatus(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {}, { maxPositionals: 1 });
  const name = parsed.positionals[0];
  if (!name) {
    console.error(`Usage: ocd stack status <name>`);
    process.exit(1);
  }
  const stackRef = await resolveStack(name);
  const payload = await get<unknown>(`/api/stacks/${stackRef.id}?validate_endpoints=1`);
  const detailRow = expectRecord(payload, "Stack status request");
  if (typeof detailRow.name !== "string" || typeof detailRow.status !== "string") {
    throw new Error("Stack status request returned a malformed response (missing name or status)");
  }
  expectArray(detailRow.apps, "Stack status apps");
  expectArray(detailRow.services, "Stack status services");
  const detail = detailRow as unknown as StackDetail;

  console.log(`${BOLD}${detail.name}${RESET}  ${colorStatus(detail.status)}`);
  if (detail.resource_status_reason) {
    console.log(`${DIM}Resources:${RESET} ${detail.resource_status_reason}`);
  }
  console.log(
    `${DIM}Last operation:${RESET} ` +
      (detail.last_operation_id
        ? `#${detail.last_operation_id} ${detail.last_operation_status}` +
          `${detail.last_operation_failed ? " (failed)" : ""}` +
          `${detail.operation_in_progress ? " (in progress)" : ""}`
        : "none"),
  );
  if ((detail.last_operation_children || []).length > 0) {
    console.log(
      `${DIM}Child operations:${RESET} ` +
        detail.last_operation_children!.map((child) => `#${child.id} ${child.kind}=${child.status}`).join(", "),
    );
  }
  console.log(`${DIM}Created:${RESET} ${(detail.created_at || "").replace("T", " ").slice(0, 16)}\n`);

  console.log(`${BOLD}Services${RESET}`);
  table(
    ["NAME", "TYPE", "VERSION", "STATUS"],
    (detail.services || []).map((s) => [s.name, s.service_type, s.version || "-", colorStatus(s.status)]),
  );
  if ((detail.public_endpoints || []).length > 0) {
    console.log(`\n${BOLD}Public endpoints${RESET}`);
    table(
      ["APP", "DOMAIN", "DNS", "EXPECTED", "TLS"],
      detail.public_endpoints!.map((endpoint) => [
        endpoint.app_name,
        endpoint.domain,
        endpoint.ready ? endpoint.resolved.join(",") : `degraded (${endpoint.resolved.join(",") || "NXDOMAIN"})`,
        endpoint.expectedTarget,
        endpoint.tlsReady ? `ready${endpoint.httpStatus ? ` (${endpoint.httpStatus})` : ""}` : `degraded: ${endpoint.tlsError || "not ready"}`,
      ]),
    );
    if ((detail.acme_errors || []).length > 0) {
      console.log(`\n${BOLD}Recent ACME errors${RESET}`);
      for (const line of detail.acme_errors!) console.log(`  ${line}`);
    }
  }

  console.log(`\n${BOLD}Apps${RESET}`);
  table(
    ["NAME", "STATUS", "ADDRESS"],
    (detail.apps || []).map((a) => [
      a.name,
      a.environment_stale
        ? `${colorStatus(a.status)} — stale environment, redeploy required`
        : colorStatus(a.status),
      a.public === false || a.public === 0 ? `${DIM}(private)${RESET}` : a.domain || "-",
    ]),
  );
}

interface OpRow {
  id: number;
  kind: string;
  resource_keys: string[];
  enqueued_at: string | null;
}

/** A failed stack deploy compensates and deletes its stacks row — exactly when
 *  the logs matter most. When no stack row exists, find the most recent
 *  deploy_stack op targeting `stack:<name>` so its logs are still reachable. */
async function findStackDeployOp(name: string): Promise<OpRow | undefined> {
  const data = await get<{ running: OpRow[]; pending: OpRow[]; recent: OpRow[] }>("/api/operations");
  const key = `stack:${name.toLowerCase()}`;
  const all = [...(data.running || []), ...(data.pending || []), ...(data.recent || [])];
  return all.find(
    (op) => op.kind === "deploy_stack" && (op.resource_keys || []).some((k) => k.toLowerCase() === key),
  );
}

async function stackLogs(args: string[]): Promise<void> {
  const filters = parseLogArgs(args);
  const name = filters.target;
  if (!name) {
    console.error(`Usage: ocd stack logs <name> [--tail N] [--since TIME] [--child NAME|ID] [--phase STEP]`);
    process.exit(1);
  }
  if (filters.follow) throw new Error("ocd stack logs does not support --follow; use ocd ops logs <id> --follow");

  const stackRef = await lookupStack(name);
  const op = await findStackDeployOp(stackRef?.name || name);
  if (op) {
    if (!stackRef) console.error(
      `${DIM}Stack "${name}" no longer exists. Showing operation #${op.id} logs:${RESET}`,
    );
    const payload = await get<unknown>(
      `/api/operations/${op.id}/logs?${operationLogQuery(filters)}`,
    );
    const row = expectRecord(payload, "Stack operation logs request");
    const logs = expectArray(row.logs, "Stack operation logs request") as Array<{ ts: string; level: string; message: string }>;
    for (const l of logs) {
      if (!l || typeof l.message !== "string") throw new Error("Stack operation logs returned a malformed log entry");
      const ts = (l.ts || "").replace("T", " ").slice(0, 19);
      console.log(`${DIM}${ts}${RESET} ${l.level} ${l.message}`);
    }
    if (logs.length === 0) console.log(`${DIM}(no operation logs matched)${RESET}`);
    return;
  }

  if (!stackRef) {
    console.error(`Stack not found: ${name}`);
    const list = await fetchStackList();
    console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
    process.exit(1);
  }
  if (filters.tail || filters.sinceTime || filters.child || filters.phase) {
    throw new Error("This legacy stack has no operation logs, so filters cannot be applied");
  }
  const payload = await get<unknown>(`/api/stacks/${stackRef.id}/log`);
  const log = expectStringField(payload, "log", "Stack log request");
  process.stdout.write(log || `${DIM}(no stack log)${RESET}\n`);
}

async function stackMemberLogs(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, { tail: { type: "string" } }, { maxPositionals: 1 });
  const name = parsed.positionals[0];
  if (!name) {
    console.error(`Usage: ocd stack member-logs <name|id> [--tail=N]`);
    process.exit(1);
  }
  const tail = positiveIntegerFlag(parsed.flags.tail, "tail", { defaultValue: 100, max: 1000 })!;
  const stackRef = await resolveStack(name);
  const payload = await get<unknown>(`/api/stacks/${stackRef.id}/member-logs?tail=${tail}`);
  const members = expectArray(expectRecord(payload, "Stack member logs request").members, "Stack member logs request") as
    Array<{ kind: "app" | "service"; id: number; name: string; logs: string; error?: string }>;
  for (const member of members) {
    console.log(`${BOLD}==> ${member.kind} ${member.name} (#${member.id}) <==${RESET}`);
    if (member.error) console.log(`${RED}${member.error}${RESET}`);
    else if (typeof member.logs !== "string") throw new Error(`Stack member logs returned malformed logs for ${member.name}`);
    else if (member.logs) process.stdout.write(member.logs.endsWith("\n") ? member.logs : `${member.logs}\n`);
    else console.log(`${DIM}(no logs)${RESET}`);
  }
  if (members.length === 0) console.log(`${DIM}(no readable member logs)${RESET}`);
}

export async function stackDown(args: string[]): Promise<void> {
  let name = "";
  for (const arg of args) {
    if (!arg.startsWith("-") && !name) name = arg;
  }
  if (!name) {
    console.error(`Usage: ocd delete stack <name>`);
    process.exit(1);
  }
  const unknown = args.filter((arg) => arg.startsWith("-"));
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}`);
    process.exit(1);
  }

  const stackRef = await resolveStack(name);

  const confirm = await webConfirm("delete_stack", "stack", stackRef.id);
  if (!confirm) {
    console.log("Aborted.");
    return;
  }

  console.log(`Destroying stack ${BOLD}${stackRef.name}${RESET}...`);
  const { op_id } = await del<{ op_id: number }>(`/api/stacks/${stackRef.id}`, undefined, {
    "X-OCD-Confirmation": confirm,
  });
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack destroyed.${RESET}`);
  } else {
    console.error(`\n${RED}Stack destroy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd stack <ls|status|logs|member-logs> [args]

${BOLD}Subcommands:${RESET}
  ls                   List all stacks
  status <name>        Show a stack's apps and services
  logs <name>          Print a stack's deploy log
  member-logs <name>   Print current container logs for every readable member

${DIM}Deploy or redeploy a stack with \`ocd deploy stack\`; destroy one with \`ocd delete stack\`.${RESET}`);
}

export async function stack(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "up":
      console.error("`ocd stack up` has moved to `ocd deploy stack`.");
      process.exit(1);
    case "ls":
      await stackLs();
      break;
    case "status":
      await stackStatus(rest);
      break;
    case "logs":
      await stackLogs(rest);
      break;
    case "member-logs":
    case "members-logs":
      await stackMemberLogs(rest);
      break;
    case "down":
      console.error("`ocd stack down` has moved to `ocd delete stack`.");
      process.exit(1);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown stack subcommand: ${sub}`);
      usage();
      process.exit(1);
  }
}
