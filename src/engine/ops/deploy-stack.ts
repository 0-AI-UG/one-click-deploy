import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
  type OperationRow,
} from "../../shared/db/operations.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { runtimeAppFromRequest, preflightRuntimeEnv } from "../../shared/runtime-env.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { validateStackReferences } from "../../shared/stack-spec.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { awaitChildren } from "./_children.ts";
import { registerOp } from "./registry.ts";
import type { OpContext, OpKindDefinition, Step } from "../types.ts";
import { classifyAppConfigChanges, classifyConfigOnlyChanges, diffAppConfig, resolveDeployRequestEnvironmentIds, type AppReconcileMode } from "../../shared/app-config.ts";
import { validateDeployRequest, assertSafeHostPath } from "../../shared/validate.ts";
import { allReplicasAttested, hashEnvironment } from "../revision.ts";
import dbInstance from "../../shared/db/connection.ts";

type DeployStackInput = StackDeployRequest;

type PlanOut = {
  stackId: number;
  environmentId: number | null;
  levels: string[][];
};

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

export function stackMemberEnvironmentId(app: DeployStackInput["apps"][number], sharedId: number | null): number | null {
  const resolved = resolveDeployRequestEnvironmentIds({
    ...app,
    environment_id: app.environment === undefined ? sharedId : undefined,
  });
  return resolved.environment_id ?? null;
}

function selectedApps(req: DeployStackInput): DeployStackInput["apps"] {
  if (!req.selected_app_keys) return req.apps;
  const selected = new Set(req.selected_app_keys);
  const byKey = new Map(req.apps.map((app) => [app.key, app]));
  // A selected consumer must see the producer configuration validated in this plan.
  for (const key of selected) {
    const app = byKey.get(key);
    if (app) for (const dependency of appDependencies(app)) selected.add(dependency);
  }
  return req.apps.filter((app) => selected.has(app.key));
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

function appDependencies(app: { needs?: string[]; env?: import("../../shared/rpc.ts").DeployRequest["env"] }): string[] {
  return [...new Set([...(app.needs ?? []), ...Object.values(app.env ?? {}).flatMap((value) =>
    typeof value !== "string" && value.from.startsWith("apps.") ? [value.from.split(".")[1]] : [])])];
}

export function topoLevels(apps: Array<{ key: string; needs?: string[]; env?: import("../../shared/rpc.ts").DeployRequest["env"] }>): string[][] {
  const appKeys = new Set(apps.map((a) => a.key));
  const deps = new Map<string, Set<string>>();
  for (const a of apps) {
    const d = new Set<string>();
    for (const n of appDependencies(a)) if (appKeys.has(n)) d.add(n);
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
    validateStackReferences(req.apps);
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
      for (const dependency of appDependencies(app)) {
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
    // Resolve every desired member, including unselected dependencies, before mutation.
    const desired = req.apps.map((app) => ({
      ...runtimeAppFromRequest({ ...app, app_name: memberName(req.name, app.key), environment_id: stackMemberEnvironmentId(app, req.environment_id ?? null) }, -1),
    }));
    for (const app of desired) await preflightRuntimeEnv(app, { apps: desired, stackNames: { [-1]: req.name } });
    topoLevels(req.apps);
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
      for (const n of appDependencies(a)) {
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

    // The manifest selects an existing environment; deployment never writes values.
    const envId = req.environment_id ?? null;
    if (envId != null && !db.getEnvironment(envId)) throw new Error(`Environment ${envId} not found`);
    const existing = db.getStackByName(req.name);
    const stackId = existing?.id ?? db.insertStack({ name: req.name, environment_id: envId }).id;
    dbInstance.query("UPDATE stacks SET environment_id = ? WHERE id = ?").run(envId, stackId);
    db.updateStackStatus(stackId, "deploying");
    db.updateStackStagingEnvironment(stackId, req.staging_environment_id ?? null);
    // Keep manifest provenance synchronized for every member, including
    // members omitted from a partial reconcile.
    if (req.stack_manifest_path !== undefined) {
      for (const member of db.getAppsByStackId(stackId)) {
        db.updateAppStackManifestPath(member.id, req.stack_manifest_path);
      }
    }

    db.appendStackLog(stackId, `[plan] ${req.apps.length} app(s), ${levels.length} level(s)`);
    return { stackId, environmentId: envId, levels };
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
    const { stackId, environmentId, levels } =
      prior["plan"] as PlanOut;
    const appByKey = new Map(req.apps.map((a) => [a.key, a]));
    const byKey = childByKey(ctx.opId);
    const preflight = prior["preflight_apps"] as PreflightOut | undefined;

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
          // The stack and standalone paths share one complete desired-config
          // apply. Stack ownership only supplies the resolved shared prod and
          // staging environments before the code-only child redeploy.
          const {
            key: _key,
            needs: _needs,
            reconcile_mode: _reconcileMode,
            ...configFields
          } = appReq;
          const candidate: import("../../shared/rpc.ts").DeployRequest = {
            ...configFields,
            apply_mode: "manifest",
            app_name: name,
            environment_id: stackMemberEnvironmentId(appReq, environmentId),
            stack_id: stackId,
            stack_manifest_path: req.stack_manifest_path ?? null,
          };
          const configChanges = diffAppConfig(existingApp, candidate);
          const requestedMode: AppReconcileMode = appReq.reconcile_mode ?? "artifact";
          const configMode = classifyAppConfigChanges(configChanges);
          const modeRank: Record<AppReconcileMode, number> = { control: 0, runtime: 1, artifact: 2 };
          const configOnlyPlan = req.config_only
            ? classifyConfigOnlyChanges(configChanges, {
                environmentChanged: requestedMode === "runtime",
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
          // Each member carries its explicit runtime map.
          const {
            key: _k,
            needs: _n,
            reconcile_mode: _reconcileMode,
            ...deployFields
          } = appReq;
          row = enqueueOperation({
            kind: "deploy",
            resourceKeys: [`app:create:${name}`],
            input: {
              ...deployFields,
              app_name: name,
              environment_id: stackMemberEnvironmentId(appReq, environmentId),
              stack_id: stackId,
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

      // Keep stack ownership and inferred dependency edges for later operations.
      for (const key of level) {
        const app = db.getAppByName(memberName(req.name, key));
        if (!app) continue;
        db.setAppStack(app.id, stackId);
        db.updateAppStackManifestPath(app.id, req.stack_manifest_path ?? null);
        // Persist the member's dependency edges. They're otherwise consumed once
        // here (topoLevels) and forgotten, which left promote_stack unable to
        // order anything — see promote-stack.ts `orderPromotions`.
        db.setAppStackNeeds(app.id, appDependencies(appByKey.get(key)!));

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
