import { sshExec, sshExecStreaming, describeFailure } from "./ssh.ts";
import { asUser } from "./container-common.ts";
import { dockerLoginRegistry, type RegistryAuth } from "./registry.ts";
import { startAppReplica } from "./docker-run.ts";
import { ensureOcdNetwork } from "./lifecycle.ts";
import { resolveRegistryCredentialsForImage } from "../registry-config.ts";

const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;

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
    const pull = await sshExecStreaming(
      ip,
      asUser(`${auth?.envPrefix ?? ""}docker pull ${opts.imageRef}`),
      { hostKey: opts.hostKey, onLine: (line) => line.trim() && onLog?.(line) },
    );
    if (pull.exitCode !== 0) throw new Error(describeFailure("Docker image pull failed", pull));
  } finally {
    if (auth) await auth.cleanup();
  }
}
