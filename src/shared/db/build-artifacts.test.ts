import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../db.ts";
import connection from "./connection.ts";
import { enqueueOperation } from "./operations.ts";

const COMMIT = "c".repeat(40);
const REPOSITORY = "https://github.com/acme/widget.git";
const IMAGE_REPOSITORY = "registry.example/acme/widget";

function operation() {
  return enqueueOperation({
    kind: "test_build_artifact",
    resourceKeys: [],
    input: { repository: REPOSITORY, commitSha: COMMIT },
    trigger: "test",
  });
}

function worker(name: string) {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `${name}-${suffix}`,
    provider_id: `${name}-${suffix}`,
    ipv4: "203.0.113.50",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  return db.insertBuildWorker({
    serverId: server.id,
    name: `${name}-${suffix}`,
    previousPool: "general",
  });
}

function imageRef(repository = IMAGE_REPOSITORY, digit = "a"): string {
  return `${repository}@sha256:${digit.repeat(64)}`;
}

describe("durable build artifacts", () => {
  test("records ordered targets and permits exact idempotent replay", () => {
    const op = operation();
    const buildWorker = worker("artifacts");
    const api = db.recordBuildArtifact({
      operationId: op.id,
      targetName: "api",
      imageRef: imageRef(),
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
    });
    const replay = db.recordBuildArtifact({
      operationId: op.id,
      targetName: "api",
      imageRef: imageRef(),
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
    });
    db.recordBuildArtifact({
      operationId: op.id,
      targetName: "worker",
      imageRef: imageRef(IMAGE_REPOSITORY, "b"),
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
    });

    expect(replay).toEqual(api);
    expect(db.listBuildArtifacts(op.id).map((artifact) => artifact.target_name)).toEqual(["api", "worker"]);
    expect(db.deleteBuildArtifacts(op.id)).toBe(2);
    expect(db.listBuildArtifacts(op.id)).toEqual([]);
  });

  test("rejects mutable references and identity replacement", () => {
    const op = operation();
    const firstWorker = worker("immutable-one");
    const secondWorker = worker("immutable-two");
    const base = {
      operationId: op.id,
      targetName: "app",
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: firstWorker.id,
    };
    expect(() => db.recordBuildArtifact({ ...base, imageRef: `${IMAGE_REPOSITORY}:latest` })).toThrow("immutable");
    db.recordBuildArtifact({ ...base, imageRef: imageRef() });
    expect(() => db.recordBuildArtifact({ ...base, imageRef: imageRef(IMAGE_REPOSITORY, "b") })).toThrow("immutable");
    expect(() => db.recordBuildArtifact({ ...base, imageRef: imageRef(), workerId: secondWorker.id }))
      .toThrow("identity mismatch");
    expect(() => db.recordBuildArtifact({
      ...base,
      targetName: "other",
      imageRef: imageRef(),
      commitSha: "d".repeat(40),
    })).toThrow("identity mismatch");

    expect(() => connection.query(
      "UPDATE build_artifacts SET image_ref = ? WHERE operation_id = ? AND target_name = ?",
    ).run(imageRef(IMAGE_REPOSITORY, "e"), op.id, "app")).toThrow("immutable");
  });

  test("saves and replays an identity-safe result checkpoint", () => {
    const op = operation();
    const buildWorker = worker("checkpoint");
    const args = {
      operationId: op.id,
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
      output: { refs: { app: imageRef() }, files: [".ocd-deploy.json"] },
    };
    const saved = db.saveBuildResultCheckpoint(args);
    const replay = db.saveBuildResultCheckpoint(args);

    expect(replay).toEqual(saved);
    expect(db.getBuildResultCheckpoint(op.id)).toEqual(saved);
    expect(JSON.parse(saved.output_json)).toEqual(args.output);
    expect(() => db.saveBuildResultCheckpoint({ ...args, output: { refs: {} } })).toThrow("immutable");
    expect(() => db.saveBuildResultCheckpoint({ ...args, commitSha: "d".repeat(40) }))
      .toThrow("identity mismatch");
  });

  test("enforces one identity across artifacts and checkpoint", () => {
    const op = operation();
    const buildWorker = worker("cross-identity");
    db.saveBuildResultCheckpoint({
      operationId: op.id,
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
      output: { refs: {} },
    });
    expect(() => db.recordBuildArtifact({
      operationId: op.id,
      targetName: "app",
      imageRef: imageRef(),
      repository: REPOSITORY,
      commitSha: "d".repeat(40),
      workerId: buildWorker.id,
    })).toThrow("identity mismatch");
  });

  test("retains provenance after its worker is decommissioned", () => {
    const op = operation();
    const buildWorker = worker("retained");
    db.recordBuildArtifact({
      operationId: op.id,
      targetName: "app",
      imageRef: imageRef(),
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
    });
    db.saveBuildResultCheckpoint({
      operationId: op.id,
      repository: REPOSITORY,
      commitSha: COMMIT,
      workerId: buildWorker.id,
      output: { refs: { app: imageRef() } },
    });

    db.deleteBuildWorker(buildWorker.id);
    expect(db.listBuildArtifacts(op.id)[0]?.worker_id).toBeNull();
    expect(db.getBuildResultCheckpoint(op.id)?.worker_id).toBeNull();
  });
});
