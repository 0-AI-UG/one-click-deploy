import { sshExec, sshExecStreaming, describeFailure } from "./ssh.ts";
import {
  asUser,
  OCD_IMAGE_PULL_MARKER_DIR,
  OCD_RUNTIME_IMAGE_REPOSITORY,
  withImageGcLease,
} from "./container-common.ts";
import { dockerLoginRegistry, type RegistryAuth } from "./registry.ts";
import { startAppReplica } from "./docker-run.ts";
import { ensureOcdNetwork } from "./lifecycle.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";

const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;

/** Local ownership tag for immutable artifacts pulled by OCD. Runtime identity
 * remains the original registry digest; this tag exists only so maintenance
 * can distinguish OCD-owned unused images from operator-owned images. */
export function managedRuntimeImageTag(name: string, imageRef: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name) || !IMMUTABLE_IMAGE.test(imageRef)) {
    throw new Error("Cannot create a managed runtime tag for an invalid app or image");
  }
  const digest = imageRef.slice(imageRef.lastIndexOf("sha256:") + "sha256:".length).toLowerCase();
  return `${OCD_RUNTIME_IMAGE_REPOSITORY}/${name}:${digest}`;
}

export function managedRuntimeImageMarker(imageRef: string): string {
  if (!IMMUTABLE_IMAGE.test(imageRef)) {
    throw new Error("Cannot create a pull marker for a mutable image");
  }
  const digest = imageRef.slice(imageRef.lastIndexOf("sha256:") + "sha256:".length).toLowerCase();
  return `${OCD_IMAGE_PULL_MARKER_DIR}/${digest}`;
}

/** Pull one immutable OCI runtime artifact. */
export async function pullImmutableImageAndRun(
  ip: string,
  opts: {
    name: string;
    imageRef: string;
    port: number;
    hostPort: number;
    envVars: Record<string, string>;
    containerName?: string;
    bindAddr?: string;
    volumeMount?: string;
    extraVolumes?: string[];
    memoryMb?: number;
    cpus?: number;
    hostKey?: string;
    configRevision?: number;
    envHash?: string;
    extraPublish?: string[];
    command?: string[];
    capAdd?: string[];
  },
  onLog?: (line: string) => void,
): Promise<{ containerId: string; imageTag: string; imageDigest: string; imageBytes: number }> {
  await pullImmutableImage(ip, {
    name: opts.name,
    imageRef: opts.imageRef,
    hostKey: opts.hostKey,
  }, onLog);

  await ensureOcdNetwork(ip, opts.hostKey);
  const { containerId } = await startAppReplica(ip, {
    containerName: opts.containerName || opts.name,
    image: opts.imageRef,
    appName: opts.name,
    bindAddr: opts.bindAddr || "127.0.0.1",
    hostPort: opts.hostPort,
    containerPort: opts.port,
    volumeMount: opts.volumeMount,
    extraVolumes: opts.extraVolumes,
    memoryMb: opts.memoryMb,
    cpus: opts.cpus,
    envVars: opts.envVars,
    configRevision: opts.configRevision,
    envHash: opts.envHash,
    extraPublish: opts.extraPublish,
    command: opts.command,
    capAdd: opts.capAdd,
  }, opts.hostKey);
  const inspected = await sshExec(
    ip,
    asUser(`docker image inspect --format '{{.Size}}' ${JSON.stringify(opts.imageRef)}`),
    opts.hostKey,
  );
  const imageBytes = Math.max(0, Number(inspected.stdout.trim()) || 0);
  return { containerId, imageTag: opts.imageRef, imageDigest: opts.imageRef, imageBytes };
}

export async function pullImmutableImage(
  ip: string,
  opts: { name: string; imageRef: string; hostKey?: string },
  onLog?: (line: string) => void,
): Promise<void> {
  if (!IMMUTABLE_IMAGE.test(opts.imageRef)) {
    throw new Error("Immutable image reference must end in @sha256:<64 hex digest>");
  }
  let auth: RegistryAuth | null = null;
  const registryCredentials = await resolveRegistryCredentialsForImage(opts.imageRef);
  if (registryCredentials.username && registryCredentials.password) {
    auth = await dockerLoginRegistry(
      ip,
      opts.imageRef,
      registryCredentials.username,
      registryCredentials.password,
      opts.hostKey,
    );
  }
  try {
    onLog?.(`Pulling immutable image ${opts.imageRef}`);
    const managedTag = managedRuntimeImageTag(opts.name, opts.imageRef);
    const pullMarker = managedRuntimeImageMarker(opts.imageRef);
    const pull = await sshExecStreaming(
      ip,
      asUser(withImageGcLease(
        `${auth?.envPrefix ?? ""}docker pull ${opts.imageRef} && ` +
          `docker image tag ${opts.imageRef} ${managedTag} && ` +
          `mkdir -p ${OCD_IMAGE_PULL_MARKER_DIR} && touch ${pullMarker}`,
      )),
      { hostKey: opts.hostKey, onLine: (line) => line.trim() && onLog?.(line) },
    );
    if (pull.exitCode !== 0) throw new Error(describeFailure("Docker image pull failed", pull));
  } finally {
    if (auth) await auth.cleanup();
  }
}
