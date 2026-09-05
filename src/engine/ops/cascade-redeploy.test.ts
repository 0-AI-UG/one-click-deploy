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
  test("reloads only apps whose runtime map references a changed key", async () => {
    const suffix = randomSuffix();
    const env = db.insertEnvironment(`cascade-${suffix}`, "{}");
    const makeApp = (name: string, keys: string[]) => {
      const app = db.insertApp({
        name: `${name}-${suffix}`,
        domain: `${name}-${suffix}.example.com`,
        image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        container_port: 3000,
        env_vars: JSON.stringify({ env: Object.fromEntries(keys.map((key) => [key, { from: `environment.${key}` }])), outputs: {} }),
        environment_id: env.id,
      });
      db.updateAppStatus(app.id, "running");
      return app;
    };
    const api = makeApp("api", ["DATABASE_URL"]);
    makeApp("docs", ["DOCS_TITLE"]);
    makeApp("empty", []);
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
    expect((resolved as { appIds: number[] }).appIds.sort()).toEqual([api.id].sort());

    await cascadeRedeployOp.steps[1].run(ctx, { resolve_apps: resolved });
    const children = listChildOperations(parent.id);
    expect(children.map((child) => child.kind)).toEqual(["reload_app"]);
    expect(children.map((child) => JSON.parse(child.input_json).appId).sort()).toEqual(
      [api.id].sort(),
    );
  });
});

test("environment changes recreate transitive consumers without rebuilding", async () => {
  const suffix = randomSuffix();
  const env = db.insertEnvironment(`transitive-${suffix}`, "{}");
  const stack = db.insertStack({ name: `transitive-${suffix}`, environment_id: env.id });
  const producer = db.insertApp({
    name: `${stack.name}-database`, domain: "", image_ref: `ghcr.io/ocd/test@sha256:${"a".repeat(64)}`,
    container_port: 5432, environment_id: env.id,
    env_vars: JSON.stringify({ env: { PASSWORD: { from: "environment.DB_PASSWORD" } }, outputs: { URL: { template: "postgres://{env.PASSWORD}@{app.host}" } } }),
  });
  const consumer = db.insertApp({
    name: `${stack.name}-web`, domain: "", image_ref: producer.image_ref, container_port: 3000,
    env_vars: JSON.stringify({ env: { DATABASE_URL: { from: "apps.database.outputs.URL" } }, outputs: {} }),
  });
  for (const app of [producer, consumer]) {
    db.setAppStack(app.id, stack.id);
    db.updateAppStatus(app.id, "running");
  }
  const parent = enqueueOperation({ kind: "cascade_redeploy", resourceKeys: [`env:${env.id}`], input: {}, trigger: "test" });
  const input = { environmentId: env.id, changedKeys: ["DB_PASSWORD"] };
  const ctx = { opId: parent.id, kind: parent.kind, input, trigger: "test", triggeredBy: "tester", parentId: null,
    attempt: 1, isCancelRequested: () => false, log: () => {}, park: () => {}, unpark: () => {},
  } satisfies OpContext<typeof input>;
  const result = await cascadeRedeployOp.steps[0].run(ctx, {}) as { appIds: number[] };
  expect(result.appIds.sort()).toEqual([producer.id, consumer.id].sort());
  await cascadeRedeployOp.steps[1].run(ctx, { resolve_apps: result });
  expect(listChildOperations(parent.id).map((operation) => operation.kind)).toEqual(["reload_app", "reload_app"]);
});
