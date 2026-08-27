import { createHash } from "node:crypto";
import * as db from "../shared/db.ts";
import type { AppRow, ReplicaRow, ServerRow } from "../shared/db.ts";
import { sshExec } from "./hetzner/ssh.ts";

export const REVISION_LABELS = {
  app: "ocd.app",
  configRevision: "ocd.config-revision",
  envHash: "ocd.env-hash",
  imageRef: "ocd.image-ref",
  imageId: "ocd.image-id",
  bindAddress: "ocd.bind-address",
  hostPort: "ocd.host-port",
} as const;

export function hashEnvironment(env: Record<string, string>): string {
  const canonical = Object.keys(env).sort().map((key) => [key, env[key]]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function latestDesiredImage(app: Pick<AppRow, "id" | "name" | "image_ref">): string {
  const deployed = db.getDeployments(app.id).find((row) => row.status === "deployed");
  const image = deployed?.image_digest || app.image_ref;
  if (!image?.includes("@sha256:")) {
    throw new Error(`App ${app.name} has no immutable registry image digest`);
  }
  return image;
}

export type ReplicaAttestation = {
  ok: boolean;
  imageDigest: string;
  envHash: string;
  configRevision: number;
  error?: string;
};

/** Verify the immutable image id and OCD-projected configuration labels on a
 * live container. Only an attested replica may transition to `running`. */
export async function attestReplica(
  app: AppRow,
  replica: ReplicaRow,
  server: ServerRow,
  expected: { imageDigest: string; envHash: string; configRevision: number },
): Promise<ReplicaAttestation> {
  const cmd = `docker inspect ${JSON.stringify(replica.container_name)} --format '{{json .}}'`;
  const result = await sshExec(
    server.ipv4,
    `su - deploy -c ${JSON.stringify(cmd)}`,
    server.ssh_host_key || undefined,
  );
  if (result.exitCode !== 0) {
    const error = `container inspection failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`;
    db.recordReplicaAttestation(replica.id, {
      imageDigest: "",
      desiredImageDigest: expected.imageDigest,
      envHash: "",
      configRevision: 0,
      error,
    });
    return { ok: false, ...expected, error };
  }
  let inspected: any;
  try {
    inspected = JSON.parse(result.stdout.trim());
  } catch {
    const error = "container inspection returned invalid JSON";
    db.recordReplicaAttestation(replica.id, {
      imageDigest: "",
      desiredImageDigest: expected.imageDigest,
      envHash: "",
      configRevision: 0,
      error,
    });
    return { ok: false, ...expected, error };
  }
  const labels = inspected?.Config?.Labels || {};
  const imageId = String(inspected?.Image || "");
  const observed = {
    imageDigest: String(labels[REVISION_LABELS.imageId] || imageId),
    envHash: String(labels[REVISION_LABELS.envHash] || ""),
    configRevision: Number(labels[REVISION_LABELS.configRevision] || 0),
  };
  const errors: string[] = [];
  if (inspected?.State?.Running !== true) errors.push("container is not running");
  if (labels[REVISION_LABELS.app] !== app.name) errors.push("app label mismatch");
  if (!imageId || observed.imageDigest !== imageId) errors.push("image id label mismatch");
  if (expected.imageDigest.includes("@sha256:") && labels[REVISION_LABELS.imageRef] !== expected.imageDigest) {
    errors.push(`image ref ${labels[REVISION_LABELS.imageRef] || "<missing>"} != ${expected.imageDigest}`);
  }
  if (observed.envHash !== expected.envHash) errors.push(`environment ${observed.envHash || "<missing>"} != ${expected.envHash}`);
  if (observed.configRevision !== expected.configRevision) errors.push(`config r${observed.configRevision} != r${expected.configRevision}`);
  const error = errors.join("; ");
  db.recordReplicaAttestation(replica.id, {
    ...observed,
    desiredImageDigest: expected.imageDigest,
    error,
  });
  return { ok: !error, ...observed, error: error || undefined };
}

export function allReplicasAttested(appId: number, expected: {
  imageDigest: string;
  envHash: string;
  configRevision: number;
}): { ok: boolean; divergent: ReplicaRow[] } {
  const divergent = db.getReplicas(appId).filter((replica) =>
    replica.status !== "running" ||
    !replica.attested_at ||
    replica.desired_image_digest !== expected.imageDigest ||
    replica.env_hash !== expected.envHash ||
    replica.config_revision !== expected.configRevision,
  );
  return { ok: divergent.length === 0, divergent };
}
