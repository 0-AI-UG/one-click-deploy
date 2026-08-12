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
import { diffAppConfig } from "../../shared/app-config.ts";
import { validateDeployRequest, assertSafeHostPath, validateRepoBuildPath } from "../../shared/validate.ts";
import { cloneRepo, findDockerfile, sshExec } from "../../shared/remote/index.ts";
import { resolveGitHubToken } from "../../shared/github-token.ts";
import type { Server } from "../../shared/rpc.ts";
import { getCatalogEntry } from "../../shared/services/catalog.ts";
import { hetzner } from "../../shared/providers/index.ts";
import { allReplicasAttested, hashEnvironment } from "../revision.ts";

type DeployStackInput = StackDeployRequest;

type PlanOut = {
  stackId: number;
  environmentId: number;
  /** The stack's shared staging environment (null = none). Members that opted
   *  into webhook staging inherit this unless they carry their own override. */
  stagingEnvironmentId: number | null;
  /** Each member key → the staging environment its sibling deploys with (the
   *  stack's one staging env, or null when that member didn't opt in — which is
   *  also what TURNS IT OFF on a re-up that dropped the opt-in). */
  stagingByKey: Record<string, number | null>;
  /** True only when this run minted the staging environment, so rollback
   *  deletes it while a reused one survives (mirrors `createdEnv`). */
  createdStagingEnv: boolean;
  /** True when at least one member currently opts into webhook staging. The
   * retained environment alone does not keep staging service counterparts. */
  stagingServicesEnabled: boolean;
  levels: string[][];
  createdStack: boolean;
  // True only when this run minted a fresh environment. A reused (pre-existing)
  // environment must survive rollback, so compensation keys off this, not
  // createdStack.
  createdEnv: boolean;
  // Service keys whose managed service ALREADY existed when this op began (a
  // re-up reconciling in place, or a manually pre-created member). These are
  // reused, not created by this run, so rollback must leave them alone. Computed
  // once in `plan` (before any member is touched) and durable across resume —
  // the live "does it exist now?" check can't be trusted mid-op because our own
  // just-created services would then look pre-existing.
  reusedServiceKeys: string[];
};

type EnqueueChildrenOut = { childIds: number[] };
type PreflightOut = {
  checkedApps: string[];
  skippedRemoteApps: string[];
  /** Git short SHA, or `artifact:<immutable-ref>` for image-mode members. */
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

function selectedServices(req: DeployStackInput): DeployStackInput["services"] {
  if (!req.selected_service_keys) return req.services;
  const selected = new Set(req.selected_service_keys);
  return req.services.filter((service) => selected.has(service.key));
}

/** Env-var prefix for a stack member key (uppercased, per the plan). */
function envPrefix(key: string): string {
  return key.toUpperCase();
}

/**
 * Topo-sort app keys into dependency levels using only app→app edges (service
 * deps are satisfied before any app runs, so `needs` entries that name a
 * service are ignored for ordering). Throws on a cycle.
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
function injectAppUrl(envId: number, key: string, app: AppRow): void {
  const url = platformEnvVars(app).OCD_INTERNAL_URL;
  const varKey = `${envPrefix(key)}_URL`;
  const envRow = db.getEnvironment(envId);
  if (!envRow) return;
  const now = new Date().toISOString();
  const entry: EnvVarEntry = { key: varKey, value: url, secret: false, updated_at: now };
  const parsed = parseEnvVars(envRow.env_vars);
  const filtered = parsed.entries.filter((e) => e.key !== varKey);
  db.updateEnvironment(envId, envRow.name, serializeEnvVars([...filtered, entry]));
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
  req: Pick<DeployStackInput, "apps" | "services">,
): string[] {
  const serviceKeys = new Set(req.services.map((service) => service.key));
  const keys: string[] = [];
  for (const dependency of appReq.needs ?? []) {
    const prefix = envPrefix(dependency);
    if (serviceKeys.has(dependency)) {
      keys.push(
        `${prefix}_URL`,
        `${prefix}_HOST`,
        `${prefix}_PORT`,
        `${prefix}_USER`,
        `${prefix}_PASSWORD`,
        `${prefix}_NAME`,
      );
    } else {
      keys.push(`${prefix}_URL`);
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
  req: Pick<DeployStackInput, "apps" | "services">,
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

async function injectExistingServiceCredentials(
  service: db.ServiceRow,
  environmentId: number,
  prefix: string,
): Promise<void> {
  const credentials = JSON.parse(service.credentials || "{}") as Record<string, unknown>;
  const now = new Date().toISOString();
  const secretKeys = new Set([`${prefix}_URL`, `${prefix}_PASSWORD`]);
  const pairs: [string, string][] = [
    [`${prefix}_URL`, String(credentials.connection_url || "")],
    [`${prefix}_HOST`, String(credentials.host || "")],
    [`${prefix}_PORT`, String(credentials.port || "")],
  ];
  if (credentials.username) pairs.push([`${prefix}_USER`, String(credentials.username)]);
  if (credentials.password) pairs.push([`${prefix}_PASSWORD`, String(credentials.password)]);
  if (credentials.database) pairs.push([`${prefix}_NAME`, String(credentials.database)]);

  const env = db.getEnvironment(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found`);
  const current = await resolveEnvVarsForDeploy(env.env_vars);
  const valuesChanged = pairs.some(([key, value]) => current[key] !== value);
  if (!valuesChanged) {
    db.insertServiceLink(service.id, environmentId, prefix);
    return;
  }

  const entries: EnvVarEntry[] = [];
  for (const [key, value] of pairs) {
    if (secretKeys.has(key)) {
      const { encrypted_value, iv } = await encryptValue(value);
      entries.push({ key, value: "", encrypted_value, iv, secret: true, updated_at: now });
    } else {
      entries.push({ key, value, secret: false, updated_at: now });
    }
  }
  const keys = new Set(entries.map((entry) => entry.key));
  const retained = parseEnvVars(env.env_vars).entries.filter((entry) => !keys.has(entry.key));
  db.updateEnvironment(environmentId, env.name, serializeEnvVars([...retained, ...entries]));
  db.insertServiceLink(service.id, environmentId, prefix);
  db.markAppsEnvironmentStaleForKeys(environmentId, entries.map((entry) => entry.key));
}

// --- Steps -----------------------------------------------------------------

const plan: Step<DeployStackInput, PlanOut> = {
  name: "plan",
  label: "Plan stack",
  async run(ctx) {
    const req = ctx.input;
    if (!req.name || !NAME_RE.test(req.name)) {
      throw new Error(
        "Stack name must start with a letter/digit and contain only lowercase letters, digits, and hyphens",
      );
    }
    const appKeys = new Set(req.apps.map((a) => a.key));
    const serviceKeys = new Set(req.services.map((s) => s.key));
    // Every dependency must resolve to a known app or service key.
    for (const a of req.apps) {
      for (const n of a.needs ?? []) {
        if (!appKeys.has(n) && !serviceKeys.has(n)) {
          throw new Error(`App "${a.key}" needs unknown key "${n}"`);
        }
      }
    }

    // Topo-sort (also detects cycles) before touching any state.
    const activeApps = selectedApps(req);
    const activeServices = selectedServices(req);
    const levels = topoLevels(activeApps);

    // Snapshot which managed services already exist before reconciliation for
    // durable plan/audit output. Both reused and newly successful services are
    // retained as checkpoints when a later child fails.
    const reusedServiceKeys = activeServices
      .filter((s) => db.getServiceByName(memberName(req.name, s.key)))
      .map((s) => s.key);

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
    let stackId: number;
    let envId: number;
    let createdStack: boolean;
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
      // it (additive: the stack layers its members' env, <KEY>_URL and service
      // creds on top of whatever it already holds) instead of minting a fresh one.
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
        const env = db.insertEnvironment(envName, "");
        envId = env.id;
        createdEnv = true;
        ctx.log(`created environment "${envName}" (${env.id})`);
      }
      const stack = db.insertStack({ name: req.name, environment_id: envId });
      stackId = stack.id;
      createdStack = true;
      ctx.log(`created stack #${stack.id} (env ${envId})`);
    }

    // Staging needs the webhook: it holds PUSHED commits, so an opt-in without
    // one can never fire. Checked before anything deploys.
    for (const a of req.apps) {
      if (a.webhook_staging && !a.webhook_enabled) {
        throw new Error(
          `App "${a.key}" sets webhook.staging but not webhook.enabled — staging holds pushed commits, so it needs the webhook.`,
        );
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
    // Runs AFTER the env-var write so an auto-created copy inherits them.
    const wantsStaging = req.apps.some((a) => a.webhook_staging);
    let stagingEnvId: number | null =
      req.staging_environment_id !== undefined
        ? req.staging_environment_id
        : (existing?.staging_environment_id ?? null);
    if (stagingEnvId != null && !db.getEnvironment(stagingEnvId)) {
      throw new Error(`Staging environment ${stagingEnvId} not found`);
    }
    let createdStagingEnv = false;
    if (stagingEnvId == null && wantsStaging) {
      // Auto-create, mirroring `<name>-stack-env`. Seeded as a COPY of the
      // production environment (ciphertext included, never round-tripped
      // through a client) so siblings boot with working values instead of an
      // empty bag — then diverge freely as you set staging-only values.
      let stagingName = `${req.name}-stack-staging-env`;
      let suffix = 1;
      while (db.getEnvironments().find((e) => e.name === stagingName)) {
        stagingName = `${req.name}-stack-staging-env-${suffix++}`;
      }
      const created = db.duplicateEnvironment(envId, stagingName);
      stagingEnvId = created.id;
      createdStagingEnv = true;
      ctx.log(`created staging environment "${stagingName}" (${created.id}) as a copy of the stack env`);
      db.appendStackLog(stackId, `[plan] created staging environment "${stagingName}"`);
    }
    const appliedStagingKeys: string[] = [];
    if (req.staging_env_vars?.length) {
      if (stagingEnvId == null) {
        throw new Error("staging_env values require at least one webhook-staging member or a selected staging environment");
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

    // One entry per member: the stack's staging env for members that opted in,
    // null for everyone else (which is also what TURNS STAGING OFF on a re-up
    // that dropped the opt-in).
    const stagingByKey: Record<string, number | null> = {};
    for (const a of req.apps) stagingByKey[a.key] = a.webhook_staging ? stagingEnvId : null;

    db.appendStackLog(stackId, `[plan] ${req.services.length} service(s), ${req.apps.length} app(s), ${levels.length} level(s)`);
    return {
      stackId,
      environmentId: envId,
      stagingEnvironmentId: stagingEnvId,
      stagingByKey,
      createdStagingEnv,
      stagingServicesEnabled: wantsStaging && stagingEnvId != null,
      levels,
      createdStack,
      createdEnv,
      reusedServiceKeys,
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
 * Validate every child before a managed service can allocate persistent
 * storage. When a ready build host exists, also clone each Git source into an
 * operation-scoped scratch directory and verify its Dockerfile/context. This
 * catches repository, branch and monorepo path mistakes without creating any
 * service volume. Scratch checkouts are always removed in the same attempt.
 */
const preflightApps: Step<DeployStackInput, PreflightOut> = {
  name: "preflight_apps",
  label: "Validate app sources",
  async run(ctx, prior) {
    const req = ctx.input;
    const checkedApps: string[] = [];
    const skippedRemoteApps: string[] = [];
    const sourceRevisionByKey: Record<string, string> = {};
    let githubToken: string | null | undefined;

    for (const appReq of selectedApps(req)) {
      const name = memberName(req.name, appReq.key);
      const validation = validateDeployRequest({ ...appReq, app_name: name });
      if (!validation.valid) throw new Error(`App "${appReq.key}": ${validation.error}`);
      for (const volume of appReq.extra_volumes ?? []) {
        assertSafeHostPath(volume.host_path, name);
      }
      if (appReq.image_ref) {
        checkedApps.push(appReq.key);
        sourceRevisionByKey[appReq.key] = `artifact:${appReq.image_ref}`;
        continue;
      }

      let server: Server | undefined;
      if (appReq.server_id) {
        const target = db.getServer(appReq.server_id) as Server | null;
        if (!target || target.status !== "ready") {
          throw new Error(`App "${appReq.key}": target server not found or not ready`);
        }
        server = target;
      } else {
        const panelServerId = db.getPanel()?.server_id;
        server = db.getServers().find((candidate: Server) =>
          candidate.status === "ready" && candidate.id !== panelServerId
        ) as Server | undefined;
      }
      if (!server) {
        skippedRemoteApps.push(appReq.key);
        ctx.log(`${appReq.key}: source check deferred because no build server is ready`);
        continue;
      }

      if (githubToken === undefined) {
        githubToken = await resolveGitHubToken(ctx.triggeredBy || undefined);
      }

      const scratchName = `preflight-${ctx.opId}-${name}`;
      const scratchDir = `/home/deploy/apps/${scratchName}`;
      let preflightFailure: unknown;
      try {
        const revision = await cloneRepo(
          server.ipv4,
          scratchName,
          appReq.git_repo,
          githubToken || undefined,
          (line) => ctx.log(`[preflight:${appReq.key}] ${line}`),
          appReq.git_branch,
          server.ssh_host_key || undefined,
          appReq.git_sha,
        );

        let dockerfile = appReq.dockerfile_path;
        if (dockerfile) {
          const pathResult = validateRepoBuildPath(dockerfile, "Dockerfile");
          if (!pathResult.valid) throw new Error(pathResult.error);
          dockerfile = pathResult.value;
        } else {
          dockerfile = await findDockerfile(server.ipv4, scratchDir, server.ssh_host_key || undefined);
        }
        if (!dockerfile) throw new Error("No Dockerfile found in the repository");
        const discoveredPath = validateRepoBuildPath(dockerfile, "Dockerfile");
        if (!discoveredPath.valid) throw new Error(discoveredPath.error);
        dockerfile = discoveredPath.value;
        const contextResult = validateRepoBuildPath(appReq.docker_context || ".", "Docker context");
        if (!contextResult.valid) throw new Error(contextResult.error);
        const paths = await sshExec(
          server.ipv4,
          `su - deploy -c ${JSON.stringify(
            `cd ${scratchDir} && test -f ${dockerfile} && test -d ${contextResult.value}`,
          )}`,
          server.ssh_host_key || undefined,
        );
        if (paths.exitCode !== 0) {
          throw new Error(
            `Dockerfile "${dockerfile}" or build context "${contextResult.value}" does not exist in the repository`,
          );
        }
        sourceRevisionByKey[appReq.key] = revision.slice(0, 12);
        checkedApps.push(appReq.key);
      } catch (error) {
        preflightFailure = error;
      }
      const cleanup = await sshExec(
        server.ipv4,
        `su - deploy -c ${JSON.stringify(`rm -rf ${scratchDir}`)}`,
        server.ssh_host_key || undefined,
      );
      if (cleanup.exitCode !== 0) {
        const original = preflightFailure
          ? `; original preflight error: ${preflightFailure instanceof Error ? preflightFailure.message : String(preflightFailure)}`
          : "";
        throw new Error(`Could not remove preflight checkout ${scratchDir}${original}`);
      }
      if (preflightFailure) throw preflightFailure;
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

const reconcileServices: Step<DeployStackInput, EnqueueChildrenOut> = {
  name: "reconcile_services",
  label: "Deploy services",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId, environmentId, stagingEnvironmentId, stagingServicesEnabled } =
      prior["plan"] as PlanOut;
    const byKey = childByKey(ctx.opId);
    const childIds: number[] = [];

    type ServiceSpec = DeployStackInput["services"][number];
    const reconcileOne = async (args: {
      svc: ServiceSpec;
      name: string;
      environmentId: number;
      target: "production" | "staging";
      targetOf?: number;
      volumeSize?: number;
      envOverrides?: Record<string, string>;
      domain?: string;
    }): Promise<void> => {
      const { svc, name, target, targetOf } = args;
      const existing = db.getServiceByName(name);
      if (existing) {
        const desiredVersion = svc.version || getCatalogEntry(svc.type)?.versions[0] || "";
        if (existing.service_type !== svc.type || existing.version !== desiredVersion) {
          throw new Error(
            `Immutable managed-service drift for "${name}": running ` +
              `${existing.service_type}:${existing.version}, manifest requires ${svc.type}:${desiredVersion}. ` +
              `Replacement plan: preserve/verify the service volume, destroy service #${existing.id}, ` +
              `then recreate it as ${svc.type}:${desiredVersion}. Confirmation is required; ` +
              `the stack is not reconciled and will not be marked successful.`,
          );
        }
        if (
          existing.target !== target ||
          (existing.target_of ?? null) !== (targetOf ?? null) ||
          existing.placement_pool !== (target === "staging" ? "staging" : "general")
        ) {
          throw new Error(
            `Managed-service identity conflict for "${name}": the existing service is not ` +
              `the stack's expected ${target} service. Refusing to adopt or move persistent data implicitly.`,
          );
        }
        // Managed-service adoption must include its provider volume, not just
        // the DB/container row. Reconcile declared sizes grow-only and wait for
        // provider confirmation before publishing credentials or reporting the
        // stack ready.
        if (args.volumeSize != null && getCatalogEntry(svc.type)?.volumePath) {
          const instance = db.getPrimaryInstance(existing.id);
          if (!instance?.volume_id) {
            throw new Error(
              `Service "${name}" declares a ${args.volumeSize}GB volume but has no recorded provider volume`,
            );
          }
          let providerVolume = await hetzner.volumes.get(instance.volume_id);
          if (providerVolume.sizeGb < args.volumeSize) {
            const resizeKey = `stack:${ctx.opId}:svc-volume-resize:${target}:${svc.key}:${args.volumeSize}`;
            const prev = byKey.get(resizeKey);
            const resize = prev ?? enqueueOperation({
              kind: "resize_volume",
              resourceKeys: [`volume:${instance.volume_id}`],
              input: { volumeId: instance.volume_id, sizeGb: args.volumeSize },
              trigger: "stack",
              triggeredBy: ctx.triggeredBy,
              parentId: ctx.opId,
              idempotencyKey: resizeKey,
            });
            childIds.push(resize.id);
            db.appendStackLog(
              stackId,
              `[services] growing ${name} volume ${instance.volume_id} ` +
                `${providerVolume.sizeGb}GB → ${args.volumeSize}GB`,
            );
            await awaitChildren(ctx, { childIds: [resize.id] });
            providerVolume = await hetzner.volumes.get(instance.volume_id);
            if (providerVolume.sizeGb < args.volumeSize) {
              throw new Error(
                `Provider did not confirm volume ${instance.volume_id} resize: ` +
                  `${providerVolume.sizeGb}GB observed, ${args.volumeSize}GB declared`,
              );
            }
          } else if (providerVolume.sizeGb > args.volumeSize) {
            ctx.log(
              `${name}: provider volume is ${providerVolume.sizeGb}GB; declared ` +
                `${args.volumeSize}GB is smaller and volumes are grow-only, leaving it unchanged`,
            );
          }
        }
        db.setServiceStack(existing.id, stackId);
        await injectExistingServiceCredentials(existing, args.environmentId, envPrefix(svc.key));
        db.appendStackLog(stackId, `[services] reconciled ${target} service ${name} (id ${existing.id})`);
        ctx.log(`reconciled ${target} service "${name}"`);
        return;
      }
      const idk = `stack:${ctx.opId}:svc:${target}:${svc.key}`;
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); return; }
      const row = enqueueOperation({
        kind: "deploy_service",
        resourceKeys: [`service:create:${name}`],
        input: {
          name,
          service_type: svc.type,
          version: svc.version,
          volume_size: args.volumeSize,
          env_overrides: args.envOverrides,
          domain: args.domain,
          environment_id: args.environmentId,
          env_prefix: envPrefix(svc.key),
          stack_id: stackId,
          target,
          target_of: targetOf,
          placement_pool: target === "staging" ? "staging" : "general",
          server_provisioning_approved: req.server_provisioning_approved === true,
        },
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(row.id);
    };

    // Production services are reconciled first because the durable production
    // id is the ownership anchor for each staging counterpart.
    for (const svc of selectedServices(req)) {
      await reconcileOne({
        svc,
        name: memberName(req.name, svc.key),
        environmentId,
        target: "production",
        volumeSize: svc.volume_size,
        envOverrides: svc.env_overrides,
        domain: svc.domain,
      });
    }
    if (childIds.length > 0) {
      db.appendStackLog(stackId, `[services] waiting for ${childIds.length} production reconcile operation(s)`);
      await awaitChildren(ctx, { childIds });
    }

    if (stagingServicesEnabled && stagingEnvironmentId != null) {
      const stagingChildStart = childIds.length;
      for (const svc of selectedServices(req)) {
        const production = db.getServiceByName(memberName(req.name, svc.key));
        if (!production) throw new Error(`Production service for "${svc.key}" was not created`);
        const stagingOverrides = {
          ...(svc.env_overrides || {}),
          ...(svc.staging?.env_overrides || {}),
        };
        await reconcileOne({
          svc,
          name: `${memberName(req.name, svc.key)}-staging`,
          environmentId: stagingEnvironmentId,
          target: "staging",
          targetOf: production.id,
          volumeSize: svc.staging?.volume_size ?? svc.volume_size,
          envOverrides: Object.keys(stagingOverrides).length ? stagingOverrides : undefined,
          // Never inherit a production HTTP hostname. Omission lets the service
          // deploy choose an isolated nip.io hostname.
          domain: svc.staging?.domain,
        });
      }
      const stagingChildIds = childIds.slice(stagingChildStart);
      if (stagingChildIds.length > 0) {
        db.appendStackLog(stackId, `[services] waiting for ${stagingChildIds.length} staging reconcile operation(s)`);
        await awaitChildren(ctx, { childIds: stagingChildIds });
      }
    }

    // Backstop ownership tags for services adopted from an earlier run. New
    // children persist them atomically with the service row.
    for (const svc of selectedServices(req)) {
      const row = db.getServiceByName(memberName(req.name, svc.key));
      if (row) db.setServiceStack(row.id, stackId);
      const staging = row ? db.getStagingService(row.id) : null;
      if (staging) db.setServiceStack(staging.id, stackId);
    }
    return { childIds };
  },
  // No compensation: successful services are resume checkpoints. A failed
  // deploy_service child compensates its own incomplete container/volume.
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
            ...configFields
          } = appReq;
          const candidate: import("../../shared/rpc.ts").DeployRequest = {
            ...configFields,
            apply_mode: "manifest",
            app_name: name,
            environment_id: environmentId,
            env_projection: effectiveProjection,
            webhook_staging: false,
            webhook_staging_environment_id: stagingEnvFor(key),
          };
          const configChanges = diffAppConfig(existingApp, candidate);
          const convergence = await stackAppAlreadyConverged(
            existingApp,
            preflight?.sourceRevisionByKey[key],
          );
          if (convergence.converged && configChanges.length === 0) {
            db.appendStackLog(stackId, `[apps] ${key}: already reconciled; skipped rollout`);
            ctx.log(`${key}: already reconciled; skipped rollout`);
            continue;
          }
          const reason = configChanges.length > 0
            ? `configuration diff: ${configChanges.map((change) => change.field).join(", ")}`
            : convergence.reason;
          ctx.log(`${key}: rollout required (${reason})`);
          row = enqueueOperation({
            kind: "redeploy",
            resourceKeys: [`app:${existingApp.id}`],
            input: {
              appId: existingApp.id,
              userId: ctx.triggeredBy || undefined,
              gitSha: appReq.git_sha,
              candidate,
            },
            trigger: "stack",
            triggeredBy: ctx.triggeredBy,
            parentId: ctx.opId,
            idempotencyKey: idk,
          });
        } else {
          // Drop per-app env_vars: the stack merged them into the shared env in
          // `plan` (with conflict checks), so members deploy against it directly.
          // `webhook_staging` is stack-only intent — the child deploy takes the
          // RESOLVED staging environment id instead.
          const {
            key: _k,
            needs: _n,
            env_vars: _e,
            webhook_staging: _s,
            env_projection_mode: _projectionMode,
            declared_env_keys: _declaredKeys,
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
              webhook_staging_environment_id: stagingEnvFor(key) ?? undefined,
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
        // Persist the member's dependency edges. They're otherwise consumed once
        // here (topoLevels) and forgotten, which left promote_stack unable to
        // order anything — see promote-stack.ts `orderPromotions`.
        db.setAppStackNeeds(app.id, appByKey.get(key)?.needs ?? null);
        // Re-point the member at the stack's staging env every deploy. The
        // child `deploy` above already carries it for NEW members, but reused
        // members took the `redeploy` path (which never touches webhook config),
        // so this is what actually reconciles them — and what turns staging OFF
        // when a deploy drops webhook.staging or clears staging_environment.
        let desiredStagingEnv = stagingEnvFor(key);
        // Staging is driven by the webhook, and only the `deploy` path registers
        // one — `redeploy` (the path every pre-existing member takes) touches no
        // webhook config. So a member that newly asks for webhooks in its
        // manifest has no webhook registered yet; recording staging against it
        // would report staging as ON while no push can ever reach it.
        if (desiredStagingEnv != null && !app.webhook_enabled) {
          db.appendStackLog(
            stackId,
            `[apps] ${key}: staging requested but no webhook is registered for this member — ` +
              `staging stays off until the webhook exists`,
          );
          ctx.log(`${key}: staging skipped — no webhook registered`);
          desiredStagingEnv = null;
        }
        if ((app.webhook_staging_environment_id ?? null) !== desiredStagingEnv) {
          db.updateAppWebhookStagingEnvironment(app.id, desiredStagingEnv);
          db.appendStackLog(
            stackId,
            desiredStagingEnv == null
              ? `[apps] ${key}: webhook staging disabled`
              : `[apps] ${key}: webhook staging → environment ${desiredStagingEnv}`,
          );
        }
        injectAppUrl(environmentId, key, app);
        // Mirror the wiring into the staging env so a staged stack resolves to
        // its own siblings rather than to production.
        if (stagingEnvironmentId != null) {
          injectStagingUrl(stagingEnvironmentId, key, app, desiredStagingEnv != null);
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
    const { stackId, stagingServicesEnabled } = prior["plan"] as PlanOut;
    if (req.partial) {
      ctx.log("partial stack reconcile: removals are disabled");
      return { removed: 0 };
    }
    const appKeys = new Set(req.apps.map((a) => a.key));
    const desiredServiceNames = new Set(
      req.services.flatMap((service) => {
        const production = memberName(req.name, service.key);
        return stagingServicesEnabled ? [production, `${production}-staging`] : [production];
      }),
    );
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
    for (const svc of db.getServicesByStackId(stackId)) {
      if (desiredServiceNames.has(svc.name)) continue;
      const idk = `stack:${ctx.opId}:rm-svc:${svc.id}`;
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); continue; }
      const op = enqueueOperation({
        kind: "destroy_service",
        resourceKeys: [
          `service:${svc.id}`,
          ...db.getServiceInstances(svc.id)
            .filter((instance) => !!instance.volume_id)
            .map((instance) => `volume:${instance.volume_id}`),
        ],
        input: { serviceId: svc.id },
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(op.id);
      db.appendStackLog(stackId, `[reconcile] removing service ${svc.name}`);
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
      `[done] stack "${req.name}" deployed: ${req.services.length} service(s), ${req.apps.length} app(s)`,
    );
    ctx.log(`stack "${req.name}" running`);
    return { ok: true };
  },
};

const deployStackOp: OpKindDefinition<DeployStackInput> = {
  kind: "deploy_stack",
  label: "Deploy stack",
  resourceKeys: (input) => [`stack:${input.name}`],
  // Source/path validation is deliberately first: no stack, environment,
  // service volume, or desired configuration is mutated until it succeeds.
  steps: [preflightApps, plan, reconcileServices, deployApps, reconcileRemovals, finalize],
};

registerOp(deployStackOp as OpKindDefinition<any>);

export default deployStackOp;
export type { DeployStackInput };
