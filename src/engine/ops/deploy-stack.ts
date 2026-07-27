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
  encryptValue,
  type EnvVarEntry,
} from "../../shared/env-crypto.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";

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

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Namespaced fleet-global member name: `<stack>-<key>`. */
function memberName(stack: string, key: string): string {
  return `${stack}-${key}`;
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

  const entries: EnvVarEntry[] = [];
  for (const [key, value] of pairs) {
    if (secretKeys.has(key)) {
      const { encrypted_value, iv } = await encryptValue(value);
      entries.push({ key, value: "", encrypted_value, iv, secret: true, updated_at: now });
    } else {
      entries.push({ key, value, secret: false, updated_at: now });
    }
  }
  const env = db.getEnvironment(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found`);
  const keys = new Set(entries.map((entry) => entry.key));
  const retained = parseEnvVars(env.env_vars).entries.filter((entry) => !keys.has(entry.key));
  db.updateEnvironment(environmentId, env.name, serializeEnvVars([...retained, ...entries]));
  db.insertServiceLink(service.id, environmentId, prefix);
  db.markAppsEnvironmentStaleForKeys(environmentId, entries.map((entry) => entry.key));
}

/**
 * Roll back every app this op deployed as NEW (child kind `deploy`) that is
 * still present, and wait for the teardowns. A member's own failure aborts the
 * `deploy_apps` step *mid-flight*, so members from earlier levels (or earlier in
 * the same level) have already succeeded and are left RUNNING — this reaps them
 * so a partial stack deploy is all-or-nothing.
 *
 * Probe-then-destroy so it is idempotent and resume-safe: an app already gone
 * (its child self-compensated, or a prior compensate attempt already destroyed
 * it) has `getAppByName === null` and is skipped; a prior destroy child is
 * re-adopted by idempotency key rather than duplicated. `redeploy` children
 * (pre-existing members reconciled in place) are intentionally left alone.
 */
async function teardownNewApps(ctx: OpContext<DeployStackInput>): Promise<void> {
  const children = listChildOperations(ctx.opId);
  const byKey = new Map(children.map((c) => [c.idempotency_key ?? "", c]));
  const childIds: number[] = [];
  const appPrefix = `stack:${ctx.opId}:app:`;
  for (const c of children) {
    if (c.kind !== "deploy") continue;
    if (!(c.idempotency_key ?? "").startsWith(appPrefix)) continue;
    let appName: string;
    try { appName = JSON.parse(c.input_json).app_name; } catch { continue; }
    const app = db.getAppByName(appName);
    if (!app) continue;
    const idk = `stack:${ctx.opId}:app-destroy:${app.id}`;
    const prev = byKey.get(idk);
    if (prev) { childIds.push(prev.id); continue; }
    const op = enqueueOperation({
      kind: "destroy_app",
      resourceKeys: [`app:${app.id}`],
      input: { appId: app.id },
      trigger: "stack",
      triggeredBy: ctx.triggeredBy,
      parentId: ctx.opId,
      idempotencyKey: idk,
    });
    childIds.push(op.id);
  }
  if (childIds.length > 0) await awaitChildren(ctx, { childIds });
}

/**
 * Roll back every managed service this op CREATED (i.e. one not in
 * `reusedServiceKeys`) that is still present, and wait for the teardowns. Like
 * `teardownNewApps`, a service's own failure can abort `reconcile_services`
 * mid-flight while sibling services already succeeded — this reaps those. A
 * reused/pre-existing service (present before this op began) is left untouched,
 * so its container + data survive a failed re-up. Idempotent and resume-safe:
 * a service already gone is skipped; a prior destroy child is re-adopted by key.
 */
async function teardownNewServices(
  ctx: OpContext<DeployStackInput>,
  reusedServiceKeys: string[],
): Promise<void> {
  const req = ctx.input;
  const reused = new Set(reusedServiceKeys);
  const byKey = childByKey(ctx.opId);
  const childIds: number[] = [];
  for (const svc of req.services) {
    if (reused.has(svc.key)) continue; // reused/pre-existing → must survive
    const row = db.getServiceByName(memberName(req.name, svc.key));
    if (!row) continue;
    const idk = `stack:${ctx.opId}:svc-destroy:${svc.key}`;
    const prev = byKey.get(idk);
    if (prev) { childIds.push(prev.id); continue; }
    const op = enqueueOperation({
      kind: "destroy_service",
      resourceKeys: [`service:${row.id}`],
      input: { serviceId: row.id },
      trigger: "stack",
      triggeredBy: ctx.triggeredBy,
      parentId: ctx.opId,
      idempotencyKey: idk,
    });
    childIds.push(op.id);
  }
  if (childIds.length > 0) await awaitChildren(ctx, { childIds });
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
    const levels = topoLevels(req.apps);

    // Snapshot which managed services already exist BEFORE we create anything —
    // these are reused and must survive a rollback (see PlanOut.reusedServiceKeys).
    const reusedServiceKeys = req.services
      .filter((s) => db.getServiceByName(memberName(req.name, s.key)))
      .map((s) => s.key);

    // Capacity pre-check: only apps not already present as `<stack>-<key>`
    // consume a new internal port.
    const newApps = req.apps.filter(
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
      const incoming = (await processIncomingEnvVars(req.env_vars)).entries;
      const envRow = db.getEnvironment(envId)!;
      const overlaid = new Set(incoming.map((e) => e.key));
      const base = parseEnvVars(envRow.env_vars).entries.filter((e) => !overlaid.has(e.key));
      db.updateEnvironment(envId, envRow.name, serializeEnvVars([...base, ...incoming]));
      ctx.log(`applied ${incoming.length} stack env var(s)`);
    }

    // --- shared staging environment ---------------------------------------
    // Deliberately the SAME model as the production environment above: the
    // stack owns exactly ONE staging environment, every staging member uses it,
    // and no member can override it. An explicit value wins (null clears it),
    // otherwise the stack keeps what it already had — so a re-up needn't
    // re-pass --staging-env, exactly like --env.
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
      levels,
      createdStack,
      createdEnv,
      reusedServiceKeys,
    };
  },
  async compensate(ctx, out) {
    if (!out) return;
    // `plan` is the first step, so its compensator ALWAYS runs on rollback —
    // whereas a step's OWN compensator is SKIPPED when the failure happens
    // *inside* that step (a failed forward step isn't replayed as compensable by
    // the step-runner). So the authoritative teardown of every member this run
    // created lives here, guaranteeing no orphaned apps/services (and their
    // containers/volumes/DNS) survive a partial stack deploy. Only NEWLY-created
    // members are reaped: reused apps (`redeploy` children) and reused services
    // (`reusedServiceKeys`) are left running so a failed re-up preserves them.
    // Awaits the destroys; a failure throws, keeping the op in 'compensating' for
    // retry rather than deleting the stack row over orphans.
    await teardownNewApps(ctx);
    await teardownNewServices(ctx, out.reusedServiceKeys);

    if (!out.createdStack) {
      // Reconcile of a pre-existing stack failed: we didn't create the stack
      // (or its env) this run, so we leave both in place — but mark the stack
      // 'failed' so a rolled-back re-up doesn't silently linger as 'running'
      // or stuck 'deploying'. The stack row + log survive for `ocd stack logs`.
      // A staging env minted by THIS run is still ours to reap, though: unlink
      // it from the surviving stack first so we don't delete a referenced row.
      if (out.createdStagingEnv && out.stagingEnvironmentId != null) {
        db.updateStackStagingEnvironment(out.stackId, null);
        db.deleteEnvironment(out.stagingEnvironmentId);
      }
      db.updateStackStatus(out.stackId, "failed");
      return;
    }
    // First-time creation failed: DB teardown of the stack + environment
    // created this run. Deleting an already-gone row is a no-op (so retry is
    // safe); let a genuine failure PROPAGATE rather than orphan the stack/env
    // rows behind a clean `compensated`. A reused environment is left in place —
    // we didn't create it, so we don't destroy it.
    //
    // First untag any surviving members this run tagged with the stack but did
    // NOT create (reused services, and reused apps if any). The teardown above
    // already deleted every member we created, so whatever still references this
    // stack is a survivor — clearing its stack_id keeps it from dangling at the
    // stack row we're about to delete.
    for (const svc of db.getServicesByStackId(out.stackId)) db.setServiceStack(svc.id, null);
    for (const appRow of db.getAppsByStackId(out.stackId)) db.setAppStack(appRow.id, null);
    db.deleteStack(out.stackId);
    if (out.createdEnv) db.deleteEnvironment(out.environmentId);
    if (out.createdStagingEnv && out.stagingEnvironmentId != null) {
      db.deleteEnvironment(out.stagingEnvironmentId);
    }
  },
};

const reconcileServices: Step<DeployStackInput, EnqueueChildrenOut> = {
  name: "reconcile_services",
  label: "Deploy services",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId, environmentId } = prior["plan"] as PlanOut;
    const byKey = childByKey(ctx.opId);
    const childIds: number[] = [];
    for (const svc of req.services) {
      const name = memberName(req.name, svc.key);
      const existing = db.getServiceByName(name);
      if (existing) {
        if (existing.service_type !== svc.type) {
          throw new Error(
            `Existing service "${name}" has type ${existing.service_type}, expected ${svc.type}; refusing unsafe adoption`,
          );
        }
        db.setServiceStack(existing.id, stackId);
        await injectExistingServiceCredentials(existing, environmentId, envPrefix(svc.key));
        db.appendStackLog(stackId, `[services] adopted existing service ${name} (id ${existing.id})`);
        ctx.log(`adopted existing service "${name}"`);
        continue;
      }
      const idk = `stack:${ctx.opId}:svc:${svc.key}`;
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); continue; }
      const row = enqueueOperation({
        kind: "deploy_service",
        resourceKeys: [`service:create:${name}`],
        input: {
          name,
          service_type: svc.type,
          version: svc.version,
          volume_size: svc.volume_size,
          env_overrides: svc.env_overrides,
          domain: svc.domain,
          environment_id: environmentId,
          env_prefix: envPrefix(svc.key),
        },
        trigger: "stack",
        triggeredBy: ctx.triggeredBy,
        parentId: ctx.opId,
        idempotencyKey: idk,
      });
      childIds.push(row.id);
    }
    if (childIds.length > 0) {
      db.appendStackLog(stackId, `[services] deploying ${childIds.length} service(s)`);
      await awaitChildren(ctx, { childIds });
    }
    // Tag each created service with this stack (child injected its creds itself).
    for (const svc of req.services) {
      const row = db.getServiceByName(memberName(req.name, svc.key));
      if (row) db.setServiceStack(row.id, stackId);
    }
    return { childIds };
  },
  // Only runs when `reconcile_services` COMPLETED and a later step failed; when
  // the failure is inside `reconcile_services` itself this compensator is skipped
  // and `plan`'s compensator does the teardown instead (both share
  // `teardownNewServices`, which is idempotent). Reused services are excluded.
  async compensate(ctx, _out, prior) {
    const reused = (prior["plan"] as PlanOut | undefined)?.reusedServiceKeys ?? [];
    await teardownNewServices(ctx, reused);
  },
};

const deployApps: Step<DeployStackInput, { ok: true }> = {
  name: "deploy_apps",
  label: "Deploy apps",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId, environmentId, stagingEnvironmentId, stagingByKey, levels } =
      prior["plan"] as PlanOut;
    const appByKey = new Map(req.apps.map((a) => [a.key, a]));
    const byKey = childByKey(ctx.opId);

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
        let row: OperationRow;
        if (existingApp) {
          // Reconcile manifest projection before the child reload/build reads
          // the linked environment. Omit means legacy/all; [] means none.
          db.updateAppEnvProjection(existingApp.id, appReq.env_projection ?? null);
          if (appReq.public === false && (existingApp.public || existingApp.domain)) {
            db.updateAppPublic(existingApp.id, false);
            db.updateAppDomain(existingApp.id, "");
            // Apply maintenance isolation before the potentially long rebuild.
            // A successful operation must not be reported while an old public
            // router is still serving this app.
            await syncAllTraefik();
            db.appendStackLog(stackId, `[apps] ${key}: public ingress removed`);
          }
          // Reconcile = redeploy the existing member (env/image refresh).
          row = enqueueOperation({
            kind: "redeploy",
            resourceKeys: [`app:${existingApp.id}`],
            input: { appId: existingApp.id, userId: ctx.triggeredBy || undefined },
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
          const { key: _k, needs: _n, env_vars: _e, webhook_staging: _s, ...deployFields } = appReq;
          row = enqueueOperation({
            kind: "deploy",
            resourceKeys: [`app:create:${name}`],
            input: {
              ...deployFields,
              app_name: name,
              environment_id: environmentId,
              webhook_staging_environment_id: stagingEnvFor(key) ?? undefined,
            },
            trigger: "stack",
            triggeredBy: ctx.triggeredBy,
            parentId: ctx.opId,
            idempotencyKey: idk,
          });
        }
        levelChildIds.push(row.id);
      }

      db.appendStackLog(stackId, `[apps] deploying level: ${level.join(", ")}`);
      ctx.log(`deploying level: ${level.join(", ")}`);
      // Readiness gate: children reach terminal-success only once healthy.
      await awaitChildren(ctx, { childIds: levelChildIds });

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
        // when a re-up drops webhook.staging or clears --staging-env.
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
  // Only runs when `deploy_apps` COMPLETED and a later step failed; when the
  // failure is inside `deploy_apps` itself this compensator is skipped and
  // `plan`'s compensator does the teardown instead (both share `teardownNewApps`,
  // which is idempotent, so a double invocation is a no-op).
  async compensate(ctx) {
    await teardownNewApps(ctx);
  },
};

const reconcileRemovals: Step<DeployStackInput, { removed: number }> = {
  name: "reconcile_removals",
  label: "Reconcile removals",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId } = prior["plan"] as PlanOut;
    const appKeys = new Set(req.apps.map((a) => a.key));
    const serviceKeys = new Set(req.services.map((s) => s.key));
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
        resourceKeys: [`app:${app.id}`],
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
      if (serviceKeys.has(deriveKey(svc.name))) continue;
      const idk = `stack:${ctx.opId}:rm-svc:${svc.id}`;
      const prev = byKey.get(idk);
      if (prev) { childIds.push(prev.id); continue; }
      const op = enqueueOperation({
        kind: "destroy_service",
        resourceKeys: [`service:${svc.id}`],
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
  steps: [plan, reconcileServices, deployApps, reconcileRemovals, finalize],
};

registerOp(deployStackOp as OpKindDefinition<any>);

export default deployStackOp;
export type { DeployStackInput };
