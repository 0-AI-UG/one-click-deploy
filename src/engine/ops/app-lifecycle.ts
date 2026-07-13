import * as db from "../../shared/db.ts";
import type { AppRow } from "../../shared/db/apps.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type AppLifecycleInput = { appId: number };
type Precond = { skip: boolean };

type AppLifecycleConfig = {
  kind: string;
  label: string;
  actionName: string;
  actionLabel: string;
  shouldSkip: (app: AppRow) => boolean;
  skipLog: (app: AppRow) => string;
  action: (appId: number) => Promise<{ ok: boolean; error?: string }>;
};

export function makeAppLifecycleOp(config: AppLifecycleConfig): OpKindDefinition<AppLifecycleInput> {
  const checkPrecondition: Step<AppLifecycleInput, Precond> = {
    name: "check_precondition",
    label: "Check current state",
    async run(ctx) {
      const app = db.getApp(ctx.input.appId);
      if (!app) throw new Error(`app ${ctx.input.appId} not found`);
      if (config.shouldSkip(app)) {
        ctx.log(config.skipLog(app));
        return { skip: true };
      }
      return { skip: false };
    },
  };

  const delegate: Step<AppLifecycleInput, { ok: true; skipped?: boolean }> = {
    name: config.actionName,
    label: config.actionLabel,
    async run(ctx, prior) {
      const pre = prior["check_precondition"] as Precond | undefined;
      if (pre?.skip) return { ok: true, skipped: true };
      const result = await config.action(ctx.input.appId);
      if (!result.ok) throw new Error(result.error || `${config.kind} returned ok=false`);
      return { ok: true };
    },
  };

  const op: OpKindDefinition<AppLifecycleInput> = {
    kind: config.kind,
    label: config.label,
    resourceKeys: (input) => [`app:${input.appId}`],
    steps: [checkPrecondition, delegate],
  };

  registerOp(op as OpKindDefinition<any>);
  return op;
}

export type { AppLifecycleInput };
