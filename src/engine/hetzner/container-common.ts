import { assertSafeHostPath } from "../../shared/validate.ts";

export function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

// Wrap a shell command so it runs as the unprivileged `deploy` user (the uid
// that owns docker). The outer SSH shell must receive a single-quoted value:
// JSON.stringify uses double quotes, which lets the outer shell expand `$var`
// and `$(...)` before `su` sees them. That silently broke GC loops and any
// other command whose variables were meant for the deploy user's shell.
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const asUser = (cmd: string) => `su - deploy -c ${shellSingleQuote(cmd)}`;

// Label applied to every image built or managed by OCD. Used by `pruneServer`
// to scope aggressive image cleanup so we never touch images that belong to
// other applications on the same host.
export const OCD_IMAGE_LABEL_KEY = "ocd.managed";
export const OCD_IMAGE_LABEL = `${OCD_IMAGE_LABEL_KEY}=true`;
export const IMAGE_GC_LOCK_PATH = "/tmp/ocd-image-gc.lock";

/** Coordinate image consumers with host-wide garbage collection. Builds and
 * docker-run take shared leases; pruning takes the exclusive side. */
export function withImageGcLease(command: string, waitSeconds = 600): string {
  return `flock -s -w ${waitSeconds} ${IMAGE_GC_LOCK_PATH} -c ${shellSingleQuote(command)}`;
}

export function withExclusiveImageGc(command: string, waitSeconds = 60): string {
  return `flock -x -w ${waitSeconds} ${IMAGE_GC_LOCK_PATH} -c ${shellSingleQuote(command)}`;
}

// Default per-container resource ceilings. Applied to every app/replica unless
// the caller overrides. Sized for small web apps; infra services pass their
// own higher ceilings via opts.
export const DEFAULT_MEM_MB = 512;
export const DEFAULT_CPUS = 1;
export const DEFAULT_PIDS = 512;
export const DEFAULT_LOG_MAX_SIZE = "20m";
export const DEFAULT_LOG_MAX_FILES = 3;

export type DockerRunVolume = { host: string; container: string };

export type DockerRunOpts = {
  /** Container name (--name). */
  name: string;
  /** Image reference (e.g. "myapp:latest" or "postgres:17-alpine"). */
  image: string;
  /** App name used to scope the volume host-path allowlist. */
  appName: string;
  /** Override the docker network. Default "ocd-net". Pass null to skip --network. */
  network?: string | null;
  /** Static hostname mappings injected into the container. OCD uses these for
   * managed-service aliases because containers do not inherit host /etc/hosts. */
  extraHosts?: Array<{ hostname: string; address: string }>;
  /** Port publish spec. Omit for containers that don't expose ports. */
  publish?: { bindAddr: string; hostPort: number; containerPort: number };
  /** Extra, already-formatted `-p ...` publish flags (e.g. the panel's waker
   *  port from wakerPublishFlags). Appended verbatim after `publish`. */
  extraPublish?: string[];
  /** Absolute path to env-file on the host (--env-file). */
  envFilePath?: string;
  /** Primary "host:container" volume mount string (validated). */
  volumeMount?: string;
  /** Additional "host:container" volume mount strings (validated). */
  extraVolumes?: string[];
  /** Per-container memory ceiling in MB. Default DEFAULT_MEM_MB. */
  memoryMb?: number;
  /** Per-container CPU ceiling. Default DEFAULT_CPUS. */
  cpus?: number;
  /** Per-container pids cap. Default DEFAULT_PIDS. */
  pidsLimit?: number;
  /** Extra Linux capabilities to add back after --cap-drop=ALL. */
  extraCaps?: string[];
  /** --restart policy. Default "unless-stopped". */
  restart?: string;
  /** Optional trailing command/args (already shell-escaped by caller). */
  cmd?: string;
  /** Deterministic workload identity labels used for replica attestation. */
  labels?: Record<string, string>;
};

function parseVolumeSpec(spec: string): { host: string; container: string } | null {
  // Volume strings are "host:container" or "host:container:ro" etc.
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) return null;
  const host = spec.slice(0, idx);
  const rest = spec.slice(idx + 1);
  // Container path may itself contain ":ro" suffix; strip after the next colon.
  const containerEnd = rest.indexOf(":");
  const container = containerEnd === -1 ? rest : rest.slice(0, containerEnd);
  return { host, container };
}

/**
 * Build a hardened `docker run` shell command. Centralizes capability drops,
 * no-new-privileges, pid limits, and default mem/cpu ceilings so no callsite
 * can forget them. Validates every host-path volume against the allowlist.
 */
export function buildDockerRunArgs(opts: DockerRunOpts): string {
  const mem = opts.memoryMb ?? DEFAULT_MEM_MB;
  const cpus = opts.cpus ?? DEFAULT_CPUS;
  const pids = opts.pidsLimit ?? DEFAULT_PIDS;
  const restart = opts.restart ?? "unless-stopped";
  const network = opts.network === null ? null : (opts.network ?? "ocd-net");

  const parts: string[] = [
    "docker run -d",
    `--name ${opts.name}`,
    `--restart ${restart}`,
    `--log-opt max-size=${DEFAULT_LOG_MAX_SIZE}`,
    `--log-opt max-file=${DEFAULT_LOG_MAX_FILES}`,
  ];
  if (network) parts.push(`--network ${network}`);
  for (const [key, value] of Object.entries(opts.labels ?? {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid Docker label: ${key}`);
    }
    parts.push(`--label ${JSON.stringify(`${key}=${value}`)}`);
  }
  for (const host of opts.extraHosts ?? []) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host.hostname)) {
      throw new Error(`Invalid extra host name: ${host.hostname}`);
    }
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host.address)) {
      throw new Error(`Invalid extra host address: ${host.address}`);
    }
    parts.push(`--add-host=${host.hostname}:${host.address}`);
  }
  parts.push(
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory ${mem}m`,
    `--memory-swap ${mem}m`,
    `--cpus ${cpus}`,
    `--pids-limit ${pids}`,
  );
  for (const cap of opts.extraCaps ?? []) {
    parts.push(`--cap-add=${cap}`);
  }

  if (opts.publish) {
    const { bindAddr, hostPort, containerPort } = opts.publish;
    parts.push(`-p ${bindAddr}:${hostPort}:${containerPort}`);
  }
  for (const flag of opts.extraPublish ?? []) parts.push(flag);
  if (opts.envFilePath) parts.push(`--env-file ${opts.envFilePath}`);

  const allVolumes: string[] = [];
  if (opts.volumeMount) allVolumes.push(opts.volumeMount);
  if (opts.extraVolumes) allVolumes.push(...opts.extraVolumes);
  for (const spec of allVolumes) {
    const parsed = parseVolumeSpec(spec);
    if (!parsed) throw new Error(`Invalid volume spec: ${spec}`);
    assertSafeHostPath(parsed.host, opts.appName);
    parts.push(`-v ${spec}`);
  }

  parts.push(opts.image);
  if (opts.cmd) parts.push(opts.cmd);
  return parts.join(" ");
}
