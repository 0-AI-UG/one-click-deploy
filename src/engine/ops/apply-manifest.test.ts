import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import type { OpContext } from "../types.ts";
import applyManifestOp from "./apply-manifest.ts";

function context(input: { appId: number; deploy: boolean; rollout?: "control" | "runtime" | "build" }) {
  return {
    opId: 7001,
    kind: "apply_manifest",
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
}

describe("apply_manifest coordinator boundaries", () => {
  test("validates before child reconciliation and records runtime history separately", async () => {
    expect(applyManifestOp.steps.map((step) => step.name)).toEqual([
      "validate_manifest",
      "reconcile_manifest",
      "record_runtime_deployment",
    ]);
    const validate = applyManifestOp.steps[0];
    await expect(validate.run(context({ appId: 999999, deploy: false }), {}))
      .rejects.toThrow(/not found/i);
  });

  test("rejects contradictory deploy/control intent without enqueueing children", async () => {
    const app = db.insertApp({
      name: `manifest-boundary-${crypto.randomUUID()}`,
      domain: "",
      git_repo: "https://github.com/acme/app",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    const validate = applyManifestOp.steps[0];
    await expect(validate.run(context({ appId: app.id, deploy: true, rollout: "control" }), {}))
      .rejects.toThrow(/control-only/);
  });
});
