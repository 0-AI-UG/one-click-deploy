import * as db from "../shared/db.ts";
import {
  findSupersedingOperation,
  getCompletedForwardSteps,
  listChildOperations,
  type OperationRow,
} from "../shared/db/operations.ts";
import { getOp } from "./ops/registry.ts";

export type CompensationPreview = {
  willCompensate: boolean;
  supersededBy: number | null;
  steps: string[];
  targets: string[];
  summary: string;
};

function json<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function addAppTarget(targets: Set<string>, name: string): void {
  const app = db.getAppByName(name);
  if (!app) return;
  targets.add(`app "${app.name}" (id ${app.id})`);
  if (app.volume_id && !app.volume_attached) {
    targets.add(`managed app volume ${app.volume_id}`);
  }
}

/** Build a server-side preview from durable forward outputs and current DB
 * identities. No client-provided description is trusted. */
export function previewCompensation(op: OperationRow): CompensationPreview {
  const superseding = findSupersedingOperation(op);
  const def = getOp(op.kind);
  const completed = new Set(getCompletedForwardSteps(op.id).map((row) => row.step));
  const steps = (def?.steps ?? [])
    .filter((step) => step.compensate && completed.has(step.name))
    .map((step) => step.label || step.name);
  const targets = new Set<string>();
  const input = json<Record<string, any>>(op.input_json, {});

  if (op.kind === "deploy_stack") {
    for (const child of listChildOperations(op.id)) {
      const childInput = json<Record<string, any>>(child.input_json, {});
      if (child.kind === "deploy" && typeof childInput.app_name === "string") {
        addAppTarget(targets, childInput.app_name);
      }
    }
    const stack = typeof input.name === "string" ? db.getStackByName(input.name) : null;
    if (stack) targets.add(`stack "${stack.name}" (id ${stack.id})`);
  } else if (op.kind === "deploy" && typeof input.app_name === "string") {
    addAppTarget(targets, input.app_name);
  } else if (typeof input.appId === "number") {
    const app = db.getApp(input.appId);
    if (app) addAppTarget(targets, app.name);
  }

  const targetList = [...targets];
  if (superseding) {
    return {
      willCompensate: false,
      supersededBy: superseding.id,
      steps,
      targets: targetList,
      summary:
        `Cancel operation #${op.id}. Its compensation is fenced because newer ` +
        `operation #${superseding.id} adopted the same resources; no rollback targets will be deleted.`,
    };
  }

  const targetText = targetList.length > 0
    ? targetList.join(", ")
    : "no currently materialized resource targets";
  const stepText = steps.length > 0 ? steps.join(", ") : "none";
  return {
    willCompensate: steps.length > 0,
    supersededBy: null,
    steps,
    targets: targetList,
    summary:
      `Cancel operation #${op.id}. Compensation steps: ${stepText}. ` +
      `Targets: ${targetText}.`,
  };
}
