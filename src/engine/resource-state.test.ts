import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import {
  enqueueOperation,
  getOperation,
  markOperationFinished,
} from "../shared/db/operations.ts";
import {
  assessOperationResources,
  deriveStackResourceState,
} from "./resource-state.ts";

describe("resource-derived stack state", () => {
  test("keeps healthy resource state separate from a failed latest operation", () => {
    const name = `state-${randomSuffix()}`;
    const env = db.insertEnvironment(`${name}-env`, "");
    const stack = db.insertStack({ name, environment_id: env.id });
    const service = db.insertService({
      name: `${name}-db`,
      service_type: "postgresql",
      version: "17",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    db.setServiceStack(service.id, stack.id);
    db.updateServiceStatus(service.id, "running");
    const failed = enqueueOperation({
      kind: "deploy_stack",
      resourceKeys: [`stack:${name}`],
      input: { name, apps: [], services: [{ key: "db" }] },
      trigger: "test",
    });
    markOperationFinished(failed.id, "failed", { message: "transient reconcile error" });

    const state = deriveStackResourceState(db.getStack(stack.id)!);

    expect(state.status).toBe("running");
    expect(state.lastOperationId).toBe(failed.id);
    expect(state.lastOperationFailed).toBe(true);
  });

  test("assesses promote_stack by stackId rather than requiring deploy input", () => {
    const name = `promote-state-${randomSuffix()}`;
    const env = db.insertEnvironment(`${name}-env`, "");
    const stack = db.insertStack({ name, environment_id: env.id });
    const service = db.insertService({
      name: `${name}-cache`,
      service_type: "redis",
      version: "7",
      port: 6379,
      env_vars: "{}",
      credentials: "{}",
    });
    db.setServiceStack(service.id, stack.id);
    db.updateServiceStatus(service.id, "running");
    const op = enqueueOperation({
      kind: "promote_stack",
      resourceKeys: [`stack:${stack.id}`, `stack:${name}`],
      input: { stackId: stack.id },
      trigger: "test",
    });

    const assessment = assessOperationResources(getOperation(op.id)!);

    expect(assessment.status).toBe("done");
    expect(assessment.safeToFinalizeDone).toBe(true);
  });

  test("is degraded when a replica is restarting before aggregate propagation", () => {
    const name = `instance-state-${randomSuffix()}`;
    const env = db.insertEnvironment(`${name}-env`, "");
    const stack = db.insertStack({ name, environment_id: env.id });
    const server = db.insertServer({
      name: `${name}-server`,
      provider_id: `provider-${randomSuffix()}`,
      ipv4: "192.0.2.20",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const app = db.insertApp({
      name: `${name}-web`,
      domain: "",
      git_repo: "https://github.com/example/web",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
    });
    db.setAppStack(app.id, stack.id);
    db.updateAppStatus(app.id, "running");
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: 3000,
      container_name: `${name}-web`,
      status: "restarting",
    });

    const state = deriveStackResourceState(db.getStack(stack.id)!);

    expect(state.status).toBe("degraded");
    expect(state.reason).toContain("restarting");
  });

  test("is degraded when a service instance is unhealthy before aggregate propagation", () => {
    const name = `service-instance-state-${randomSuffix()}`;
    const env = db.insertEnvironment(`${name}-env`, "");
    const stack = db.insertStack({ name, environment_id: env.id });
    const server = db.insertServer({
      name: `${name}-server`,
      provider_id: `provider-${randomSuffix()}`,
      ipv4: "192.0.2.21",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const service = db.insertService({
      name: `${name}-db`,
      service_type: "postgresql",
      version: "17",
      port: 5432,
      env_vars: "{}",
      credentials: "{}",
    });
    db.setServiceStack(service.id, stack.id);
    db.updateServiceStatus(service.id, "running");
    db.insertServiceInstance({
      service_id: service.id,
      server_id: server.id,
      container_name: `${name}-db`,
      role: "primary",
      host_port: 5432,
      status: "unhealthy",
    });

    const state = deriveStackResourceState(db.getStack(stack.id)!);

    expect(state.status).toBe("degraded");
    expect(state.reason).toContain("unhealthy");
  });
});
