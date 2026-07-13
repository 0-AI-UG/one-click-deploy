import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  type OperationRow,
} from "../../shared/db/operations.ts";
import {
  parseEnvVars,
  serializeEnvVars,
  platformEnvVars,
  type EnvVarEntry,
} from "../../shared/env-crypto.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DeployStackInput = StackDeployRequest;

type PlanOut = {
  stackId: number;
  environmentId: number;
  levels: string[][];
  createdStack: boolean;
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

function childByKey(opId: number): Map<string, OperationRow> {
  return new Map(listChildOperations(opId).map((c) => [c.idempotency_key ?? "", c]));
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
    const existing = db.getStackByName(req.name);
    if (existing) {
      const envId = existing.environment_id;
      if (!envId) throw new Error(`Stack "${req.name}" has no environment`);
      ctx.log(`reusing existing stack #${existing.id} (env ${envId})`);
      return { stackId: existing.id, environmentId: envId, levels, createdStack: false };
    }

    let envName = `${req.name}-stack-env`;
    let suffix = 1;
    while (db.getEnvironments().find((e) => e.name === envName)) {
      envName = `${req.name}-stack-env-${suffix++}`;
    }
    const env = db.insertEnvironment(envName, "");
    const stack = db.insertStack({ name: req.name, environment_id: env.id });
    ctx.log(`created stack #${stack.id} with environment "${envName}" (${env.id})`);
    db.appendStackLog(stack.id, `[plan] ${req.services.length} service(s), ${req.apps.length} app(s), ${levels.length} level(s)`);
    return { stackId: stack.id, environmentId: env.id, levels, createdStack: true };
  },
  async compensate(ctx, out) {
    if (!out || !out.createdStack) return;
    try { db.deleteStack(out.stackId); } catch (err) { ctx.log(`deleteStack failed: ${err}`); }
    try { db.deleteEnvironment(out.environmentId); } catch (err) { ctx.log(`deleteEnvironment failed: ${err}`); }
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
  async compensate(ctx) {
    const req = ctx.input;
    const byKey = childByKey(ctx.opId);
    const childIds: number[] = [];
    for (const svc of req.services) {
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
  },
};

const deployApps: Step<DeployStackInput, { ok: true }> = {
  name: "deploy_apps",
  label: "Deploy apps",
  async run(ctx, prior) {
    const req = ctx.input;
    const { stackId, environmentId, levels } = prior["plan"] as PlanOut;
    const appByKey = new Map(req.apps.map((a) => [a.key, a]));
    const byKey = childByKey(ctx.opId);

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
          const { key: _k, needs: _n, ...deployFields } = appReq;
          row = enqueueOperation({
            kind: "deploy",
            resourceKeys: [`app:create:${name}`],
            input: { ...deployFields, app_name: name, environment_id: environmentId },
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
        injectAppUrl(environmentId, key, app);
      }
    }
    return { ok: true };
  },
  async compensate(ctx) {
    const req = ctx.input;
    const children = listChildOperations(ctx.opId);
    const byKey = new Map(children.map((c) => [c.idempotency_key ?? "", c]));
    const childIds: number[] = [];
    const appPrefix = `stack:${ctx.opId}:app:`;
    for (const c of children) {
      // Only apps deployed as NEW this run (kind 'deploy') are rolled back;
      // redeploys reused a pre-existing app and are left in place.
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
