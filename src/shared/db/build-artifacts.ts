import db from "./connection.ts";

export type BuildArtifactRow = {
  operation_id: number;
  target_name: string;
  image_ref: string;
  repository: string;
  commit_sha: string;
  worker_id: number | null;
  verified_at: string;
};

export type BuildResultCheckpointRow = {
  operation_id: number;
  repository: string;
  commit_sha: string;
  worker_id: number | null;
  output_json: string;
  created_at: string;
};

type BuildIdentity = {
  operationId: number;
  repository: string;
  commitSha: string;
  workerId: number;
};

function assertBuildIdentity(identity: BuildIdentity): void {
  if (!Number.isInteger(identity.operationId) || identity.operationId <= 0) {
    throw new Error("Build artifact operationId must be a positive integer");
  }
  if (!identity.repository || identity.repository !== identity.repository.trim()) {
    throw new Error("Build artifact repository must be non-empty and trimmed");
  }
  if (!identity.commitSha || identity.commitSha !== identity.commitSha.trim()) {
    throw new Error("Build artifact commitSha must be non-empty and trimmed");
  }
  if (!Number.isInteger(identity.workerId) || identity.workerId <= 0) {
    throw new Error("Build artifact workerId must be a positive integer");
  }
}

function assertMatchingIdentity(
  existing: Pick<BuildArtifactRow | BuildResultCheckpointRow, "repository" | "commit_sha" | "worker_id">,
  expected: BuildIdentity,
): void {
  if (
    existing.repository !== expected.repository ||
    existing.commit_sha !== expected.commitSha ||
    existing.worker_id !== expected.workerId
  ) {
    throw new Error(`Build result identity mismatch for operation ${expected.operationId}`);
  }
}

function firstArtifact(operationId: number): BuildArtifactRow | null {
  return db.query(
    "SELECT * FROM build_artifacts WHERE operation_id = ? ORDER BY target_name LIMIT 1",
  ).get(operationId) as BuildArtifactRow | null;
}

/**
 * Persist one registry-verified build output. Replaying the exact record is
 * idempotent; changing any identity field or digest for an existing target is
 * rejected so a resumed operation cannot silently adopt another build.
 */
export function recordBuildArtifact(args: BuildIdentity & {
  targetName: string;
  imageRef: string;
}): BuildArtifactRow {
  assertBuildIdentity(args);
  if (!args.targetName || args.targetName !== args.targetName.trim()) {
    throw new Error("Build artifact targetName must be non-empty and trimmed");
  }
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(args.imageRef)) {
    throw new Error("Build artifact imageRef must be an immutable repository@sha256 digest");
  }

  return db.transaction(() => {
    const checkpoint = getBuildResultCheckpoint(args.operationId);
    if (checkpoint) assertMatchingIdentity(checkpoint, args);
    const operationArtifact = firstArtifact(args.operationId);
    if (operationArtifact) assertMatchingIdentity(operationArtifact, args);

    const existing = db.query(
      "SELECT * FROM build_artifacts WHERE operation_id = ? AND target_name = ?",
    ).get(args.operationId, args.targetName) as BuildArtifactRow | null;
    if (existing) {
      assertMatchingIdentity(existing, args);
      if (existing.image_ref !== args.imageRef) {
        throw new Error(
          `Build artifact image_ref is immutable for operation ${args.operationId} target ${args.targetName}`,
        );
      }
      return existing;
    }

    return db.query(
      `INSERT INTO build_artifacts
        (operation_id, target_name, image_ref, repository, commit_sha, worker_id)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      args.operationId,
      args.targetName,
      args.imageRef,
      args.repository,
      args.commitSha,
      args.workerId,
    ) as BuildArtifactRow;
  })();
}

export function listBuildArtifacts(operationId: number): BuildArtifactRow[] {
  return db.query(
    "SELECT * FROM build_artifacts WHERE operation_id = ? ORDER BY target_name",
  ).all(operationId) as BuildArtifactRow[];
}

export function deleteBuildArtifacts(operationId: number): number {
  return db.query("DELETE FROM build_artifacts WHERE operation_id = ?").run(operationId).changes;
}

/** Save an immutable build result checkpoint, allowing exact retry replay. */
export function saveBuildResultCheckpoint(args: BuildIdentity & {
  output: unknown;
}): BuildResultCheckpointRow {
  assertBuildIdentity(args);
  let outputJson: string;
  try {
    const encoded = JSON.stringify(args.output);
    if (encoded === undefined) throw new Error("not JSON serializable");
    outputJson = encoded;
  } catch (error) {
    throw new Error(`Build result checkpoint output must be JSON serializable: ${String(error)}`);
  }

  return db.transaction(() => {
    const artifact = firstArtifact(args.operationId);
    if (artifact) assertMatchingIdentity(artifact, args);
    const existing = getBuildResultCheckpoint(args.operationId);
    if (existing) {
      assertMatchingIdentity(existing, args);
      if (existing.output_json !== outputJson) {
        throw new Error(`Build result checkpoint is immutable for operation ${args.operationId}`);
      }
      return existing;
    }
    return db.query(
      `INSERT INTO build_result_checkpoints
        (operation_id, repository, commit_sha, worker_id, output_json)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      args.operationId,
      args.repository,
      args.commitSha,
      args.workerId,
      outputJson,
    ) as BuildResultCheckpointRow;
  })();
}

export function getBuildResultCheckpoint(operationId: number): BuildResultCheckpointRow | null {
  return db.query(
    "SELECT * FROM build_result_checkpoints WHERE operation_id = ?",
  ).get(operationId) as BuildResultCheckpointRow | null;
}
