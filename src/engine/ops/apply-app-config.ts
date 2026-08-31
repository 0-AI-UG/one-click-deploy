import { applyAppConfig } from "../../shared/app-config.ts";
import * as db from "../../shared/db.ts";
import type { DeployRequest } from "../../shared/rpc.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { commitManifestDeliverySource } from "../manifest-delivery-source.ts";

type ApplyAppConfigInput = { appId: number; userId?: string; spec: DeployRequest };

const apply: Step<ApplyAppConfigInput, { changed: string[] }> = {
  name: "apply_config",
  label: "Apply desired configuration",
  async run(ctx) {
    const changes = await applyAppConfig(ctx.input.appId, ctx.input.spec, {
      userId: ctx.input.userId,
      log: (line) => {
        db.appendDeployLog(ctx.input.appId, `[config] ${line}`);
        ctx.log(line);
      },
    });
    await commitManifestDeliverySource(ctx.input.appId, ctx.input.spec.delivery_source);
    await syncAppIngress(ctx.input.appId);
    return { changed: changes.map((change) => change.field) };
  },
};

const op: OpKindDefinition<ApplyAppConfigInput> = {
  kind: "apply_app_config",
  label: "Apply app configuration",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [apply],
};

registerOp(op as OpKindDefinition<any>);
export default op;
