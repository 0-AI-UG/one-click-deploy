import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  enqueueOperation,
  listChildOperations,
} from "../../shared/db/operations.ts";
import type { OpContext } from "../types.ts";
import cascadeRedeployOp from "./cascade-redeploy.ts";

describe("cascade_redeploy selection", () => {
  test("reloads only apps whose projection consumes a changed key", async () => {
    const suffix = randomSuffix();
    const env = db.insertEnvironment(`cascade-${suffix}`, "{}");
    const makeApp = (name: string, projection: string[] | null) => {
      const app = db.insertApp({
        name: `${name}-${suffix}`,
        domain: `${name}-${suffix}.example.com`,
        image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        container_port: 3000,
        env_vars: "{}",
        environment_id: env.id,
        env_projection: projection,
      });
      db.updateAppStatus(app.id, "running");
      return app;
    };
    const api = makeApp("api", ["DATABASE_URL"]);
    makeApp("docs", ["DOCS_TITLE"]);
    const legacy = makeApp("legacy", null);
    const parent = enqueueOperation({
      kind: "cascade_redeploy",
      resourceKeys: [`env:${env.id}`],
      input: {},
      trigger: "test",
    });
    const input = {
      environmentId: env.id,
      changedKeys: ["DATABASE_URL"],
      mode: "restart" as const,
    };
    const ctx = {
      opId: parent.id,
      kind: parent.kind,
      input,
      trigger: "test",
      triggeredBy: "tester",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: () => {},
      park: () => {},
      unpark: () => {},
    } satisfies OpContext<typeof input>;

    const resolved = await cascadeRedeployOp.steps[0].run(ctx, {});
    expect((resolved as { appIds: number[] }).appIds.sort()).toEqual([api.id, legacy.id].sort());

    await cascadeRedeployOp.steps[1].run(ctx, { resolve_apps: resolved });
    const children = listChildOperations(parent.id);
    expect(children.map((child) => child.kind)).toEqual(["reload_app", "reload_app"]);
    expect(children.map((child) => JSON.parse(child.input_json).appId).sort()).toEqual(
      [api.id, legacy.id].sort(),
    );
  });
});
