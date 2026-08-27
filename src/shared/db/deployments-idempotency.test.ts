import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { expect, test } from "bun:test";
import * as db from "../db.ts";

test("deployment history is idempotent for an operation id", () => {
  const server = db.insertServer({
    name: `deployment-idk-server-${randomSuffix()}`,
    provider_id: `provider-${randomSuffix()}`,
    ipv4: "10.0.0.1",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
  const name = `deployment-idk-app-${randomSuffix()}`;
  const { app } = db.insertAppWithFirstReplica({
    name,
    domain: `${name}.example.com`,
    image_ref: `ghcr.io/acme/test@sha256:${"a".repeat(64)}`,
    container_port: 3000,
    env_vars: "{}",
  }, server.id);

  const first = db.insertDeployment({
    operation_id: 99123,
    app_id: app.id,
    image_tag: `${name}:latest`,
    git_commit: "abcdef1",
  });
  const replay = db.insertDeployment({
    operation_id: 99123,
    app_id: app.id,
    image_tag: `${name}:latest`,
    git_commit: "abcdef1",
  });

  expect(replay.id).toBe(first.id);
  expect(db.getDeployments(app.id).filter((row) => row.operation_id === 99123)).toHaveLength(1);
});
