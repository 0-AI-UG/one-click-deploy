import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  type OperationRow,
} from "../../shared/db/operations.ts";
import {
  parseEnvVars,
  serializeEnvVars,
  processIncomingEnvVars,
  platformEnvVars,
  resolveAppEnvVars,
  resolveEnvVarsForDeploy,
  encryptValue,
  isSuspiciousSecretKey,
  type EnvVarEntry,
} from "../../shared/env-crypto.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import { classifyAppConfigChanges, classifyConfigOnlyChanges, diffAppConfig, type AppReconcileMode } from "../../shared/app-config.ts";
import { validateDeployRequest, assertSafeHostPath } from "../../shared/validate.ts";
import { allReplicasAttested, hashEnvironment } from "../revision.ts";
import dbInstance from "../../shared/db/connection.ts";

type DeployStackInput = StackDeployRequest;

type PlanOut = {
  stackId: number;
  environmentId: number;
  /** The stack's explicitly selected staging environment (null = none). */
  stagingEnvironmentId: number | null;
  /** Each member key → the staging environment its sibling deploys with (the
   *  stack's one staging env, or null when no staging target is requested. */
  stagingByKey: Record<string, number | null>;
  /** True only when this run minted the staging environment, so rollback
   *  deletes it while a reused one survives (mirrors `createdEnv`). */
  createdStagingEnv: boolean;
  levels: string[][];
  createdStack: boolean;
  // True only when this run minted a fresh environment. A reused (pre-existing)
  // environment must survive rollback, so compensation keys off this, not
  // createdStack.
  createdEnv: boolean;
};

type EnqueueChildrenOut = { childIds: number[] };
type PreflightOut = {
  checkedApps: string[];
  skippedRemoteApps: string[];
  /** Immutable artifact identity for each app member. */
  sourceRevisionByKey: Record<string, string>;
};

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Namespaced fleet-global member name: `<stack>-<key>`. */
function memberName(stack: string, key: string): string {
  return `${stack}-${key}`;
}

function selectedApps(req: DeployStackInput): DeployStackInput["apps"] {
  if (!req.selected_app_keys) return req.apps;
  const selected = new Set(req.selected_app_keys);
  return req.apps.filter((app) => selected.has(app.key));
}

/** Env-var prefix for a stack member key (uppercased, per the plan). */
function envPrefix(key: string): string {
  return key.toUpperCase();
}

/**
 * Topo-sort app keys into dependency levels. Throws on a cycle.
 */
/** True when deploying `newAppCount` additional apps would push the fleet past
 *  its internal-port cap. Pure arithmetic so the guard is unit-testable without
 *  materializing hundreds of app rows (which would trip the port allocator). */
export function portCapacityExceeded(existingAppCount: number, newAppCount: number, cap: number): boolean {
  return existingAppCount + newAppCount > cap;
}

export function topoLevels(apps: Array<{ key: string; needs?: string[] }>): string[][] {
  const appKeys = new Set(apps.map((a) => a.key));
  const deps = new Map<string, Set<string>>();
  for (const a of apps) {
    const d = new Set<string>();
    for (const n of a.needs ?? []) if (appKeys.has(n)) d.add(n);
    deps.set(a.key, d);
  }
  const levels: string[][] = [];
  const remaining = new Set(appKeys);
  while (remaining.size > 0) {
    const level = [...remaining]
      .filter((k) => [...deps.get(k)!].every((d) => !remaining.has(d)))
      .sort();
    if (level.length === 0) {
      throw new Error(
        `Cycle detected in app dependencies among: ${[...remaining].sort().join(", ")}`,
      );
    }
    for (const k of level) remaining.delete(k);
    levels.push(level);
  }
  return levels;
}

/** Inject `<KEY>_URL = <app's OCD_INTERNAL_URL>` into the stack environment
 *  (plaintext — an internal URL is not a secret), replacing any prior value. */
export function injectAppUrl(envId: number, key: string, app: AppRow): void {
  const url = platformEnvVars(app).OCD_INTERNAL_URL;
  const varKey = `${envPrefix(key)}_URL`;
  const envRow = db.getEnvironment(envId);
  if (!envRow) return;
  const parsed = parseEnvVars(envRow.env_vars);
  const existing = parsed.entries.filter((entry) => entry.key === varKey);
  if (existing.length === 1 && !existing[0].secret && existing[0].value === url && existing[0].injected_by === key) return;
  const now = new Date().toISOString();
  const entry: EnvVarEntry = { key: varKey, value: url, secret: false, updated_at: now, injected_by: key };
  const filtered = parsed.entries.filter((e) => e.key !== varKey);
  db.updateEnvironment(envId, envRow.name, serializeEnvVars([...filtered, entry]), { injection: true });
}

/** Publish manifest-defined dependency outputs into the shared environment.
 * Templates deliberately have a tiny vocabulary: the internal app host/port
 * plus values already present in the target environment. */
export async function injectAppExports(
  envId: number,
  key: string,
  app: AppRow,
  exports: Record<string, { value: string; secret?: boolean }> | undefined,
): Promise<void> {
  if (!exports || Object.keys(exports).length === 0) return;
  const env = db.getEnvironment(envId);
  if (!env) throw new Error(`Environment ${envId} not found`);
  const values = await resolveEnvVarsForDeploy(env.env_vars);
  const now = new Date().toISOString();
  const outputs: Array<{ key: string; value: string; secret: boolean }> = [];
  for (const [exportKey, definition] of Object.entries(exports)) {
    const rendered = definition.value.replace(/\{(app\.host|app\.port|env\.[A-Z_][A-Z0-9_]*)\}/g, (_match, token: string) => {
      if (token === "app.host") return `${app.name}.ocd.internal`;
      if (token === "app.port") return String(app.container_port);
      const envKey = token.slice(4);
      if (!(envKey in values)) throw new Error(`Export ${key}.${exportKey} references missing environment key ${envKey}`);
      return values[envKey];
    });
    const variable = `${envPrefix(key)}_${exportKey}`;
    outputs.push({ key: variable, value: rendered, secret: definition.secret === true });
  }
  const existingEntries = new Map(parseEnvVars(env.env_vars).entries.map((entry) => [entry.key, entry]));
  if (outputs.every((output) => values[output.key] === output.value && existingEntries.get(output.key)?.secret === output.secret && existingEntries.get(output.key)?.injected_by === key)) {
    return;
  }
  const entries: EnvVarEntry[] = [];
  for (const output of outputs) {
    if (output.secret) {
      const { encrypted_value, iv } = await encryptValue(output.value);
      entries.push({ key: output.key, value: "", encrypted_value, iv, secret: true, updated_at: now, injected_by: key });
    } else {
      entries.push({ key: output.key, value: output.value, secret: false, updated_at: now, injected_by: key });
    }
  }
  const replaced = new Set(entries.map((entry) => entry.key));
  const retained = parseEnvVars(env.env_vars).entries.filter((entry) => !replaced.has(entry.key));
  db.updateEnvironment(envId, env.name, serializeEnvVars([...retained, ...entries]), { injection: true });
}

/**
 * Publish `<KEY>_URL` into the STAGING environment. Without this a staging
 * sibling resolves its peers through whatever the staging env was seeded with —
 * i.e. the PRODUCTION members — so a staged `web` would call production `api`.
 *
 * Members that stage point at their sibling; members that don't have no staged
 * copy to point at, so they keep their production URL. The sibling need not
 * exist yet: an internal URL is derived purely from name/protocol/port
 * (platformEnvVars), and the sibling is always `<member>-staging`.
 */
function injectStagingUrl(stagingEnvId: number, key: string, app: AppRow, staged: boolean): void {
  injectAppUrl(stagingEnvId, key, staged ? ({ ...app, name: `${app.name}-staging` } as AppRow) : app);
}

/** Overlay incoming values only when plaintext actually changed. Secret
 * ciphertext is intentionally randomized, so comparing serialized rows would
 * spuriously bump every linked app's config revision on every stack retry. */
async function applyEnvironmentOverlayIfChanged(
  environmentId: number,
  incomingValues: NonNullable<DeployStackInput["env_vars"]>,
): Promise<string[]> {
  const env = db.getEnvironment(environmentId);
  if (!env || incomingValues.length === 0) return [];
  const existing = await resolveEnvVarsForDeploy(env.env_vars);
  const changedKeys = incomingValues
    .filter((entry) => existing[entry.key] !== entry.value)
    .map((entry) => entry.key);
  if (changedKeys.length === 0) return [];
  const incoming = (await processIncomingEnvVars(incomingValues)).entries;
  const overlaid = new Set(incoming.map((entry) => entry.key));
  const base = parseEnvVars(env.env_vars).entries.filter((entry) => !overlaid.has(entry.key));
  db.updateEnvironment(environmentId, env.name, serializeEnvVars([...base, ...incoming]));
  return changedKeys;
}

type StackAppRequest = DeployStackInput["apps"][number];

/** Dependency variables are generated into the shared environment, so the
 * safe projection must include them even though they are not present in the
 * child manifest's env declarations. */
export function dependencyProjectionKeys(
  appReq: Pick<StackAppRequest, "needs">,
  req: Pick<DeployStackInput, "apps">,
): string[] {
  const keys: string[] = [];
  for (const dependency of appReq.needs ?? []) {
    const prefix = envPrefix(dependency);
    keys.push(`${prefix}_URL`);
    const dependencyApp = req.apps.find((app) => app.key === dependency);
    for (const exportKey of Object.keys(dependencyApp?.exports ?? {})) {
      keys.push(`${prefix}_${exportKey}`);
    }
  }
  return keys;
}

function projectionMode(appReq: StackAppRequest): "declared" | "explicit" | "all" {
  if (appReq.env_projection_mode) return appReq.env_projection_mode;
  if (appReq.env_projection === null) return "all";
  if (appReq.env_projection !== undefined) return "explicit";
  return "declared";
}

export function leastPrivilegeProjection(
  appReq: StackAppRequest,
  req: Pick<DeployStackInput, "apps">,
): string[] {
  const declared = appReq.declared_env_keys ??
    (Array.isArray(appReq.env_vars) ? appReq.env_vars.map((entry) => entry.key) : []);
  return [...new Set([...declared, ...dependencyProjectionKeys(appReq, req)])].sort();
}

export function suspiciousUnrelatedProjectionKeys(
  environmentKeys: string[],
  allowedKeys: string[],
  effectiveProjection: string[] | null,
): string[] {
  const allowed = new Set(allowedKeys);
  const received = effectiveProjection === null ? null : new Set(effectiveProjection);
  return [...new Set(environmentKeys
    .filter((key) => isSuspiciousSecretKey(key))
    .filter((key) => received === null || received.has(key))
    .filter((key) => !allowed.has(key)))]
    .sort();
}

function warnPublicAppSecretExposure(
  ctx: OpContext<DeployStackInput>,
  stackId: number,
  environmentId: number,
  key: string,
  appReq: StackAppRequest,
  effectiveProjection: string[] | null,
): void {
  const isPublic = appReq.public !== false;
  if (!isPublic) return;
  const env = db.getEnvironment(environmentId);
  if (!env) return;
  const unrelated = suspiciousUnrelatedProjectionKeys(
    parseEnvVars(env.env_vars).entries.map((entry) => entry.key),
    leastPrivilegeProjection(appReq, ctx.input),
    effectiveProjection,
  );
  if (unrelated.length === 0) return;
  const message =
    `[security] public app ${key} receives suspicious unrelated variable(s): ` +
    `${[...new Set(unrelated)].sort().join(", ")}; declare only required keys or remove env_all`;
  ctx.log(message);
  db.appendStackLog(stackId, message);
}

function childByKey(opId: number): Map<string, OperationRow> {
  return new Map(listChildOperations(opId).map((c) => [c.idempotency_key ?? "", c]));
}

// --- Steps -----------------------------------------------------------------

type ValidatePlanOut = { levels: string[][]; newApps: number };

const validatePlan: Step<DeployStackInput, ValidatePlanOut> = {
  name: "validate_plan",
  label: "Validate stack plan",
  async run(ctx) {
    const req = ctx.input;
    if (!req.name || !NAME_RE.test(req.name)) {
      throw new Error(
        "Stack name must start with a letter/digit and contain only lowercase letters, digits, and hyphens",
      );
    }
    const appKeys = new Set(req.apps.map((app) => app.key));
    if (appKeys.size !== req.apps.length) throw new Error("Stack app keys must be unique");
    for (const key of req.selected_app_keys ?? []) {
      if (!appKeys.has(key)) throw new Error(`Selected app key "${key}" is not declared in the stack`);
    }
    for (const app of req.apps) {
      if (!NAME_RE.test(app.key)) throw new Error(`Invalid app key "${app.key}"`);
      const validation = validateDeployRequest({
        ...app,
        app_name: memberName(req.name, app.key),
      });
      if (!validation.valid) {
        throw new Error(`App "${app.key}": ${validation.error}`);
      }
      for (const dependency of app.needs ?? []) {
        if (!appKeys.has(dependency)) {
          throw new Error(`App "${app.key}" needs unknown key "${dependency}"`);
        }
      }
    }
    if (req.environment_id != null && !db.getEnvironment(req.environment_id)) {
      throw new Error(`Environment ${req.environment_id} not found`);
    }
    if (req.staging_environment_id != null && !db.getEnvironment(req.staging_environment_id)) {
      throw new Error(`Staging environment ${req.staging_environment_id} not found`);
    }
    const existing = db.getStackByName(req.name);
    const effectiveStagingId = req.staging_environment_id !== undefined
      ? req.staging_environment_id
      : existing?.staging_environment_id ?? null;
    if (req.staging_env_vars?.length && effectiveStagingId == null) {
      throw new Error("staging_env values require a selected staging environment");
    }
    const activeApps = selectedApps(req);
    const levels = topoLevels(activeApps);
    const newApps = activeApps.filter(
      (app) => !db.getAppByName(memberName(req.name, app.key)),
    ).length;
    if (portCapacityExceeded(db.countApps(), newApps, db.INTERNAL_PORT_COUNT)) {
      throw new Error(
        `Stack needs ${newApps} new app port(s) but only ${db.INTERNAL_PORT_COUNT - db.countApps()} of the ${db.INTERNAL_PORT_COUNT} fleet internal ports remain. Destroy an app or shrink the stack.`,
      );
    }
    return { levels, newApps };
  },
};

const plan: Step<DeployStackInput, PlanOut> = {
  name: "plan",
  label: "Plan stack",
  async run(ctx, prior) {
    const req = ctx.input;
    if (!req.name || !NAME_RE.test(req.name)) {
      throw new Error(
        "Stack name must start with a letter/digit and contain only lowercase letters, digits, and hyphens",
      );
    }
    const appKeys = new Set(req.apps.map((a) => a.key));
    // Keep direct step invocation safe as well as normal runner execution:
    // every validation that depends only on input/current state precedes the
    // first stack/environment mutation.
    if (req.staging_environment_id != null && !db.getEnvironment(req.staging_environment_id)) {
      throw new Error(`Staging environment ${req.staging_environment_id} not found`);
    }
    // Every dependency must resolve to a known app key.
    for (const a of req.apps) {
      for (const n of a.needs ?? []) {
        if (!appKeys.has(n)) {
          throw new Error(`App "${a.key}" needs unknown key "${n}"`);
        }
      }
    }

    // Topo-sort (also detects cycles) before touching any state.
    const activeApps = selectedApps(req);
    const levels = (prior["validate_plan"] as ValidatePlanOut | undefined)?.levels ?? topoLevels(activeApps);

    // Capacity pre-check: only apps not already present as `<stack>-<key>`
    // consume a new internal port.
    const newApps = activeApps.filter(
      (a) => !db.getAppByName(memberName(req.name, a.key)),
    ).length;
    if (portCapacityExceeded(db.countApps(), newApps, db.INTERNAL_PORT_COUNT)) {
      throw new Error(
        `Stack needs ${newApps} new app port(s) but only ${db.INTERNAL_PORT_COUNT - db.countApps()} of the ${db.INTERNAL_PORT_COUNT} fleet internal ports remain. Destroy an app or shrink the stack.`,
      );
    }

    // Idempotent upsert: reuse an existing stack (resume) or create it + env.
    let stackId = 0;
    let envId: number;
    let createdStack = false;
    let createdEnv: boolean;
    const existing = db.getStackByName(req.name);
    if (existing) {
      if (!existing.environment_id) throw new Error(`Stack "${req.name}" has no environment`);
      stackId = existing.id;
      envId = existing.environment_id;
      createdStack = false;
      createdEnv = false;
      // Reflect the in-progress re-up in `stack ls` (and reset any prior
      // 'failed'); finalize flips it back to 'running' on success.
      db.updateStackStatus(stackId, "deploying");
      ctx.log(`reusing existing stack #${existing.id} (env ${envId})`);
    } else {
      // First-time creation. If the caller named an existing environment, attach
      // it (additive: the stack layers its members' environment and dependency
      // exports on top of whatever it already holds) instead of minting a fresh one.
      if (req.environment_id != null) {
        const env = db.getEnvironment(req.environment_id);
        if (!env) throw new Error(`Environment ${req.environment_id} not found`);
        envId = env.id;
        createdEnv = false;
        ctx.log(`reusing existing environment "${env.name}" (${env.id})`);
      } else {
        let envName = `${req.name}-stack-env`;
        let suffix = 1;
        while (db.getEnvironments().find((e) => e.name === envName)) {
          envName = `${req.name}-stack-env-${suffix++}`;
        }
        const created = dbInstance.transaction(() => {
          const env = db.insertEnvironment(envName, "");
          const stack = db.insertStack({ name: req.name, environment_id: env.id });
          return { env, stack };
        })();
        envId = created.env.id;
        stackId = created.stack.id;
        createdEnv = true;
        createdStack = true;
        ctx.log(`created environment "${envName}" (${created.env.id})`);
        ctx.log(`created stack #${created.stack.id} (env ${envId})`);
      }
      if (!createdEnv) {
        const stack = db.insertStack({ name: req.name, environment_id: envId });
        stackId = stack.id;
        createdStack = true;
        ctx.log(`created stack #${stack.id} (env ${envId})`);
      }
    }
    // Keep manifest provenance synchronized for every member, including
    // members omitted from a partial reconcile.
    if (req.stack_manifest_path !== undefined) {
      for (const member of db.getAppsByStackId(stackId)) {
        db.updateAppStackManifestPath(member.id, req.stack_manifest_path);
      }
    }

    // Write the caller's already-merged member env (manifest defaults + --set,
    // conflict-checked and existing-wins-filtered client-side) into the shared
    // environment. Overlay by key; runs every deploy so re-ups reconcile env.
    if (req.env_vars && req.env_vars.length > 0) {
      const changedKeys = await applyEnvironmentOverlayIfChanged(envId, req.env_vars);
      ctx.log(changedKeys.length > 0
        ? `applied ${changedKeys.length} changed stack env var(s): ${changedKeys.join(", ")}`
        : "stack environment already matches; no configuration revision bump");
    }

    // --- shared staging environment ---------------------------------------
    // Deliberately the SAME model as the production environment above: the
    // stack owns exactly ONE staging environment, every staging member uses it,
    // and no member can override it. An explicit value wins (null clears it),
    // otherwise the stack keeps what it already had — so a re-up needn't
    // repeat the staging_environment field, exactly like environment.
    //
    // Staging targets are created explicitly; selecting an environment alone
    // never creates or deploys additional workloads.
    let stagingEnvId: number | null =
      req.staging_environment_id !== undefined
        ? req.staging_environment_id
        : (existing?.staging_environment_id ?? null);
    if (stagingEnvId != null && !db.getEnvironment(stagingEnvId)) {
      throw new Error(`Staging environment ${stagingEnvId} not found`);
    }
    const createdStagingEnv = false;
    const appliedStagingKeys: string[] = [];
    if (req.staging_env_vars?.length) {
      if (stagingEnvId == null) {
        throw new Error("staging_env values require a selected staging environment");
      }
      const changedKeys = await applyEnvironmentOverlayIfChanged(stagingEnvId, req.staging_env_vars);
      appliedStagingKeys.push(...req.staging_env_vars.map((entry) => entry.key));
      ctx.log(changedKeys.length > 0
        ? `applied ${changedKeys.length} changed staging-only env var(s)`
        : "staging environment already matches; no configuration revision bump");
    }
    if (req.staging_env_keys !== undefined) {
      let previouslyCertified: string[] = [];
      try {
        const parsed = JSON.parse(existing?.staging_env_keys || "[]");
        if (Array.isArray(parsed)) previouslyCertified = parsed.map(String);
      } catch { /* invalid legacy state certifies nothing */ }
      const declared = new Set(req.staging_env_keys);
      // A wire request cannot certify an inherited value merely by naming it:
      // it must have been certified earlier or carry a value in this request.
      const nextCertified = [
        ...previouslyCertified.filter((key) => declared.has(key)),
        ...appliedStagingKeys,
      ];
      db.updateStackStagingEnvKeys(stackId, nextCertified);
    }
    db.updateStackStagingEnvironment(stackId, stagingEnvId);
    if (stagingEnvId != null && !createdStagingEnv) {
      ctx.log(`staging environment: "${db.getEnvironment(stagingEnvId)?.name}" (${stagingEnvId})`);
    }

    // Stack deployment reconciles production members only. Explicit staging
    // apps are released and promoted independently.
    const stagingByKey: Record<string, number | null> = {};
    for (const a of req.apps) stagingByKey[a.key] = null;

    db.appendStackLog(stackId, `[plan] ${req.apps.length} app(s), ${levels.length} level(s)`);
    return {
      stackId,
      environmentId: envId,
      stagingEnvironmentId: stagingEnvId,
      stagingByKey,
      createdStagingEnv,
      levels,
      createdStack,
      createdEnv,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    // Stack deploy is level-triggered convergence, not an all-or-nothing
    // transaction. Successful children are durable checkpoints and are kept so
    // a retry can skip them; a failing child compensates only its own partial
    // resources. Retain the stack/environments even on a first deploy and make
    // the incomplete state explicit.
    db.updateStackStatus(out.stackId, "failed");
    db.appendStackLog(
      out.stackId,
      `[failed] reconcile operation #${ctx.opId} stopped; successful members were retained for resume`,
    );
  },
};

/**
 * Validate every immutable child artifact before deployment. OCD never
 * fetches source during preflight.
 */
const preflightApps: Step<DeployStackInput, PreflightOut> = {
  name: "preflight_apps",
  label: "Validate app artifacts",
  async run(ctx, prior) {
    const req = ctx.input;
    const checkedApps: string[] = [];
    const skippedRemoteApps: string[] = [];
    const sourceRevisionByKey: Record<string, string> = {};

    for (const appReq of selectedApps(req)) {
      const name = memberName(req.name, appReq.key);
      const validation = validateDeployRequest({ ...appReq, app_name: name });
      if (!validation.valid) throw new Error(`App "${appReq.key}": ${validation.error}`);
      for (const volume of appReq.extra_volumes ?? []) {
        assertSafeHostPath(volume.host_path, name);
      }
      checkedApps.push(appReq.key);
      sourceRevisionByKey[appReq.key] = appReq.git_commit || `artifact:${appReq.image_ref}`;
    }
    const existingStack = db.getStackByName(req.name);
    if (existingStack) {
      db.appendStackLog(
        existingStack.id,
        `[preflight] validated ${checkedApps.length} app(s)` +
          (skippedRemoteApps.length ? `; remote source deferred for ${skippedRemoteApps.join(", ")}` : ""),
      );
    }
    return { checkedApps, skippedRemoteApps, sourceRevisionByKey };
  },
};

export async function stackAppAlreadyConverged(
  app: AppRow,
  desiredSourceRevision: string | undefined,
): Promise<{ converged: boolean; reason: string }> {
  if (!desiredSourceRevision) return { converged: false, reason: "source revision was not preflighted" };
  if (app.status !== "running") return { converged: false, reason: `status is ${app.status}` };
  if (app.environment_stale) return { converged: false, reason: "linked environment is stale" };
  const replicas = db.getReplicas(app.id);
  if (replicas.length !== app.desired_replicas) {
    return {
      converged: false,
      reason: `replicas ${replicas.length}/${app.desired_replicas}`,
    };
  }
  const deployment = db.getDeployments(app.id).find((row) => row.status === "deployed");
  if (!deployment) return { converged: false, reason: "no successful deployment identity" };
  if (desiredSourceRevision.startsWith("artifact:")) {
    const desiredRef = desiredSourceRevision.slice("artifact:".length);
    if (deployment.image_digest !== desiredRef) {
      return { converged: false, reason: "immutable image digest changed" };
    }
  } else if (deployment.git_commit !== desiredSourceRevision) {
    return {
      converged: false,
      reason: `commit ${deployment.git_commit || "unknown"} != ${desiredSourceRevision}`,
    };
  }
  const envHash = hashEnvironment(await resolveAppEnvVars(app));
  if (deployment.env_hash !== envHash) {
    return { converged: false, reason: "environment hash changed" };
  }
  if (deployment.config_revision !== app.config_revision) {
    return {
      converged: false,
      reason: `config r${deployment.config_revision} != r${app.config_revision}`,
    };
  }
  const imageDigest = deployment.image_digest || app.image_ref;
  if (!imageDigest) return { converged: false, reason: "missing immutable image identity" };
  const attested = allReplicasAttested(app.id, {
    imageDigest,
    envHash,
    configRevision: app.config_revision,
  });
  if (!attested.ok) {
    return { converged: false, reason: `${attested.divergent.length} replica(s) not attested` };
  }
  return { converged: true, reason: "source, config, environment, replicas, and links match" };
}

const deployApps: Step<DeployStackInput, { ok: true }> = {
  name: "deploy_apps",
  label: "Deploy apps",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId, environmentId, stagingEnvironmentId, stagingByKey, levels } =
      prior["plan"] as PlanOut;
    const appByKey = new Map(req.apps.map((a) => [a.key, a]));
    const byKey = childByKey(ctx.opId);
    const preflight = prior["preflight_apps"] as PreflightOut | undefined;

    /** The environment a member's staging sibling deploys with, resolved in
     *  `plan` (override > shared > stored). null = staging off for this member. */
    const stagingEnvFor = (key: string): number | null => stagingByKey[key] ?? null;

    for (const level of levels) {
      const levelChildIds: number[] = [];
      for (const key of level) {
        const appReq = appByKey.get(key)!;
        const name = memberName(req.name, key);
        const idk = `stack:${ctx.opId}:app:${key}`;
        const prev = byKey.get(idk);
        if (prev) { levelChildIds.push(prev.id); continue; }

        const existingApp = db.getAppByName(name);
        const mode = projectionMode(appReq);
        // Omitted projection is least-privilege for new members. Existing
        // members retain their stored behavior until env/env_all is explicit,
        // avoiding a surprise rollout-time compatibility break.
        const effectiveProjection = existingApp && mode === "declared"
          ? db.parseAppEnvProjection(existingApp)
          : mode === "declared"
            ? leastPrivilegeProjection(appReq, req)
            : mode === "all"
              ? null
              : (appReq.env_projection ?? []);
        warnPublicAppSecretExposure(
          ctx,
          stackId,
          environmentId,
          key,
          {
            ...appReq,
            public: appReq.public ?? (existingApp ? existingApp.public === 1 : true),
          },
          effectiveProjection,
        );
        let row: OperationRow;
        if (existingApp) {
          // The stack and standalone paths share one complete desired-config
          // apply. Stack ownership only supplies the resolved shared prod and
          // staging environments before the code-only child redeploy.
          const {
            key: _key,
            needs: _needs,
            env_projection_mode: _projectionMode,
            declared_env_keys: _declaredKeys,
            reconcile_mode: _reconcileMode,
            ...configFields
          } = appReq;
          const candidate: import("../../shared/rpc.ts").DeployRequest = {
            ...configFields,
            apply_mode: "manifest",
            app_name: name,
            environment_id: environmentId,
            env_projection: effectiveProjection,
            stack_manifest_path: req.stack_manifest_path ?? null,
          };
          const configChanges = diffAppConfig(existingApp, candidate);
          const requestedMode: AppReconcileMode = appReq.reconcile_mode ?? "artifact";
          const configMode = classifyAppConfigChanges(configChanges);
          const modeRank: Record<AppReconcileMode, number> = { control: 0, runtime: 1, artifact: 2 };
          const configOnlyPlan = req.config_only
            ? classifyConfigOnlyChanges(configChanges, {
                environmentChanged: requestedMode === "runtime" || (req.env_vars?.length ?? 0) > 0,
              })
            : null;
          const reconcileMode = configOnlyPlan
            ? configOnlyPlan.rollout
            : modeRank[configMode] > modeRank[requestedMode] ? configMode : requestedMode;
          const convergence = await stackAppAlreadyConverged(
            existingApp,
            preflight?.sourceRevisionByKey[key],
          );
          if (convergence.converged && configChanges.length === 0 && reconcileMode !== "control") {
            db.appendStackLog(stackId, `[apps] ${key}: already reconciled; skipped rollout`);
            ctx.log(`${key}: already reconciled; skipped rollout`);
            continue;
          }
          const reason = configChanges.length > 0
            ? `configuration diff: ${configChanges.map((change) => change.field).join(", ")}`
            : convergence.reason;
          ctx.log(`${key}: ${reconcileMode} reconciliation (${reason})`);
          row = enqueueOperation({
            kind: "apply_manifest",
            resourceKeys: [`manifest:${existingApp.id}`],
            input: {
              appId: existingApp.id,
              userId: ctx.triggeredBy || undefined,
              deploy: reconcileMode === "artifact",
              rollout: reconcileMode,
              pendingRollout: configOnlyPlan?.pendingRollout === true,
              spec: candidate,
            },
            trigger: "stack",
            triggeredBy: ctx.triggeredBy,
            parentId: ctx.opId,
            idempotencyKey: idk,
          });
        } else {
          // Drop per-app env_vars: the stack merged them into the shared env in
          // `plan` (with conflict checks), so members deploy against it directly.
          // The child deploy takes the resolved environment id.
          const {
            key: _k,
            needs: _n,
            env_vars: _e,
            env_projection_mode: _projectionMode,
            declared_env_keys: _declaredKeys,
            reconcile_mode: _reconcileMode,
            ...deployFields
          } = appReq;
          row = enqueueOperation({
            kind: "deploy",
            resourceKeys: [`app:create:${name}`],
            input: {
              ...deployFields,
              app_name: name,
              environment_id: environmentId,
              env_projection: effectiveProjection,
              stack_manifest_path: req.stack_manifest_path ?? null,
              server_provisioning_approved: req.server_provisioning_approved === true,
            },
            trigger: "stack",
            triggeredBy: ctx.triggeredBy,
            parentId: ctx.opId,
            idempotencyKey: idk,
          });
        }
        levelChildIds.push(row.id);
      }

      db.appendStackLog(
        stackId,
        levelChildIds.length > 0
          ? `[apps] deploying level: ${level.join(", ")}`
          : `[apps] level already reconciled: ${level.join(", ")}`,
      );
      ctx.log(
        levelChildIds.length > 0
          ? `deploying level: ${level.join(", ")}`
          : `level already reconciled: ${level.join(", ")}`,
      );
      // Readiness gate: children reach terminal-success only once healthy.
      if (levelChildIds.length > 0) await awaitChildren(ctx, { childIds: levelChildIds });

      // Tag members + publish each app's URL so the next level inherits it.
      for (const key of level) {
        const app = db.getAppByName(memberName(req.name, key));
        if (!app) continue;
        db.setAppStack(app.id, stackId);
        db.updateAppStackManifestPath(app.id, req.stack_manifest_path ?? null);
        // Persist the member's dependency edges. They're otherwise consumed once
        // here (topoLevels) and forgotten, which left promote_stack unable to
        // order anything — see promote-stack.ts `orderPromotions`.
        db.setAppStackNeeds(app.id, appByKey.get(key)?.needs ?? null);
        const desiredStagingEnv = stagingEnvFor(key);
        injectAppUrl(environmentId, key, app);
        await injectAppExports(environmentId, key, app, appByKey.get(key)?.exports);
        // Mirror the wiring into the staging env so a staged stack resolves to
        // its own siblings rather than to production.
        if (stagingEnvironmentId != null) {
          const stagedApp = desiredStagingEnv != null
            ? ({ ...app, name: `${app.name}-staging` } as AppRow)
            : app;
          injectStagingUrl(stagingEnvironmentId, key, app, desiredStagingEnv != null);
          await injectAppExports(stagingEnvironmentId, key, stagedApp, appByKey.get(key)?.exports);
        }
      }
    }
    return { ok: true };
  },
  // No compensation: successful app children are retained and attested so a
  // later stack retry can skip them.
};

const reconcileRemovals: Step<DeployStackInput, { removed: number }> = {
  name: "reconcile_removals",
  label: "Reconcile removals",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId } = prior["plan"] as PlanOut;
    if (req.partial) {
      ctx.log("partial stack reconcile: removals are disabled");
      return { removed: 0 };
    }
    const appKeys = new Set(req.apps.map((a) => a.key));
    const prefix = `${req.name}-`;
    const deriveKey = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

    const byKey = childByKey(ctx.opId);
    const childIds: number[] = [];
    for (const app of db.getAppsByStackId(stackId)) {
      if (appKeys.has(deriveKey(app.name))) continue;
      const idk = `stack:${ctx.opId}:rm-app:${app.id}`;
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); continue; }
      const op = enqueueOperation({
        kind: "destroy_app",
        resourceKeys: [
          `app:${app.id}`,
          ...(app.volume_id ? [`volume:${app.volume_id}`] : []),
        ],
        input: { appId: app.id },
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(op.id);
      db.appendStackLog(stackId, `[reconcile] removing app ${app.name}`);
    }
    if (childIds.length > 0) await awaitChildren(ctx, { childIds });
    return { removed: childIds.length };
  },
  // No compensate: removals are not part of building this run and are not rolled back.
};

const finalize: Step<DeployStackInput, { ok: true }> = {
  name: "finalize",
  label: "Finalize stack",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId } = prior["plan"] as PlanOut;
    db.updateStackStatus(stackId, "running");
    db.appendStackLog(
      stackId,
      `[done] stack "${req.name}" deployed: ${req.apps.length} app(s)`,
    );
    ctx.log(`stack "${req.name}" running`);
    return { ok: true };
  },
};

const deployStackOp: OpKindDefinition<DeployStackInput> = {
  kind: "deploy_stack",
  label: "Deploy stack",
  resourceKeys: (input) => [`stack:${input.name}`],
  // Pure plan validation and source/path preflight both finish before any
  // stack, environment, volume, or desired configuration is mutated.
  steps: [validatePlan, preflightApps, plan, deployApps, reconcileRemovals, finalize],
};

registerOp(deployStackOp as OpKindDefinition<any>);

export default deployStackOp;
export type { DeployStackInput };
