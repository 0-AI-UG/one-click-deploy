import type { ServerRow } from "../shared/db/servers.ts";
import { sshExec, sshExecStreaming, sshExecWithStdin } from "./hetzner/ssh.ts";
import { dockerLoginRegistry } from "./hetzner/registry.ts";
import { asUser } from "./hetzner/container-common.ts";

export const BUILD_WORKER_VERSION = "1";
const WORKER_DIR = "/opt/ocd-build-worker";
const LEGACY_RUNNER_DIR = "/opt/ocd-actions-runner";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizeBuildWorkerName(value: string): string {
  const name = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : "";
}

export function buildInstallWorkerScript(removalToken = ""): string {
  const token = shellQuote(removalToken.trim());
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `if [ -f ${LEGACY_RUNNER_DIR}/.runner ]; then`,
    `  removal_token=${token}`,
    "  if [ -z \"$removal_token\" ]; then echo 'GitHub runner removal token required for conversion' >&2; exit 42; fi",
    `  systemctl stop ocd-github-runner.service 2>/dev/null || true`,
    `  cd ${LEGACY_RUNNER_DIR}`,
    "  runuser -u ocd-runner -- ./config.sh remove --token \"$removal_token\"",
    "fi",
    "systemctl disable --now ocd-github-runner.service 2>/dev/null || true",
    "rm -f /etc/systemd/system/ocd-github-runner.service",
    `rm -rf ${LEGACY_RUNNER_DIR}`,
    "systemctl daemon-reload",
    "apt-get update -qq",
    "apt-get install -y -qq git jq unzip ca-certificates curl",
    "docker buildx version >/dev/null",
    "id deploy >/dev/null 2>&1 || { echo 'deploy user missing' >&2; exit 43; }",
    "usermod -aG docker deploy",
    `install -d -o deploy -g deploy -m 0750 ${WORKER_DIR} ${WORKER_DIR}/work`,
    `printf '%s\\n' ${shellQuote(BUILD_WORKER_VERSION)} > ${WORKER_DIR}/version`,
    `chown deploy:deploy ${WORKER_DIR}/version`,
    `printf 'OCD_BUILD_WORKER_READY\\t%s\\t%s\\n' ${shellQuote(BUILD_WORKER_VERSION)} \"$(uname -m)\"`,
  ].join("\n");
}

export async function runBuildWorkerInstall(server: ServerRow, script: string) {
  return sshExec(server.ipv4, script, server.ssh_host_key || undefined);
}

export async function probeBuildWorker(server: ServerRow): Promise<{
  online: boolean;
  version: string;
  architecture: string;
  diskFreeBytes: number;
  error: string;
}> {
  const result = await sshExec(
    server.ipv4,
    `set -eu; test -f ${WORKER_DIR}/version; ! systemctl is-active --quiet ocd-github-runner.service; ` +
      `version=$(cat ${WORKER_DIR}/version); docker version --format '{{.Server.Version}}' >/dev/null; ` +
      `docker buildx version >/dev/null; git --version >/dev/null; ` +
      `printf '%s\\t%s\\t%s\\n' \"$version\" \"$(uname -m)\" \"$(df -B1 / | awk 'NR==2 {print $4}')\"`,
    server.ssh_host_key || undefined,
  );
  if (result.exitCode !== 0) {
    return { online: false, version: "", architecture: "", diskFreeBytes: 0, error: result.stderr.trim().slice(0, 2000) };
  }
  const [version = "", architecture = "", disk = "0"] = result.stdout.trim().split("\t");
  return { online: version === BUILD_WORKER_VERSION, version, architecture, diskFreeBytes: Number(disk) || 0, error: "" };
}

export type BuildTarget = {
  name: string;
  dockerfile: string;
  context: string;
  image: string;
};

export async function buildCommitOnWorker(input: {
  server: ServerRow;
  operationId: number;
  repository: string;
  commit: string;
  targets?: BuildTarget[];
  resolveTargets?: (readFile: (path: string) => Promise<string>) => Promise<BuildTarget[]>;
  readFiles?: string[];
  gitUsername?: string;
  gitToken?: string;
  registryUsername?: string;
  registryPassword?: string;
  resolveRegistryCredentials?: (image: string) => Promise<{ username?: string; password?: string }>;
  onLog?: (line: string) => void;
}): Promise<{ refs: Map<string, string>; files: Record<string, string> }> {
  if (!/^[0-9a-f]{40,64}$/i.test(input.commit)) throw new Error("Build commit must be a full immutable Git SHA");
  const server = input.server;
  const root = `${WORKER_DIR}/work/op-${input.operationId}`;
  const checkout = `${root}/repo`;
  const gitHome = `${root}/git-home`;
  const hostKey = server.ssh_host_key || undefined;
  const repository = shellQuote(input.repository);
  await sshExec(server.ipv4, `rm -rf ${shellQuote(root)} && install -d -o deploy -g deploy -m 0700 ${shellQuote(root)} ${shellQuote(gitHome)}`, hostKey);

  let registryAuth: Awaited<ReturnType<typeof dockerLoginRegistry>> | null = null;
  try {
    if (input.gitToken) {
      const host = new URL(input.repository).hostname;
      const netrc = `machine ${host}\nlogin ${input.gitUsername || "x-access-token"}\npassword ${input.gitToken}\n`;
      const written = await sshExecWithStdin(
        server.ipv4,
        `install -o deploy -g deploy -m 0600 /dev/stdin ${shellQuote(`${gitHome}/.netrc`)}`,
        netrc,
        hostKey,
      );
      if (written.exitCode !== 0) throw new Error("Could not stage private Git credentials on build worker");
    }
    input.onLog?.(`Checking out ${input.repository} at ${input.commit.slice(0, 12)}`);
    const clone = await sshExecStreaming(
      server.ipv4,
      asUser(
        `HOME=${shellQuote(gitHome)} GIT_TERMINAL_PROMPT=0 git init ${shellQuote(checkout)} && ` +
        `cd ${shellQuote(checkout)} && git remote add origin ${repository} && ` +
        `HOME=${shellQuote(gitHome)} GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin ${shellQuote(input.commit)} && ` +
        `git checkout --detach FETCH_HEAD && test \"$(git rev-parse HEAD)\" = ${shellQuote(input.commit)}`,
      ),
      { hostKey, onLine: (line) => line.trim() && input.onLog?.(line) },
    );
    if (clone.exitCode !== 0) throw new Error(`Git checkout failed: ${(clone.stderr || clone.stdout).trim().split("\n").slice(-3).join(" | ")}`);

    const files: Record<string, string> = {};
    const readFile = async (file: string): Promise<string> => {
      if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) {
        throw new Error(`Unsafe repository file path requested: ${file}`);
      }
      if (files[file] !== undefined) return files[file];
      const content = await sshExec(server.ipv4, asUser(`base64 -w0 ${shellQuote(`${checkout}/${file}`)}`), hostKey);
      if (content.exitCode !== 0) throw new Error(`Repository file is missing at commit ${input.commit.slice(0, 12)}: ${file}`);
      files[file] = Buffer.from(content.stdout.trim(), "base64").toString("utf8");
      return files[file];
    };
    for (const file of [...new Set(input.readFiles || [])]) await readFile(file);
    const targets = input.resolveTargets ? await input.resolveTargets(readFile) : input.targets || [];
    if (!targets.length) throw new Error("Build request contains no image targets");
    for (const target of targets) {
      if (!target.name || !target.dockerfile || !target.context || !target.image) throw new Error("Build target is incomplete");
      for (const path of [target.dockerfile, target.context]) {
        if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) throw new Error(`Unsafe build path: ${path}`);
      }
      if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i.test(target.image)) throw new Error(`Invalid OCI repository: ${target.image}`);
    }

    const registryResolutions = input.resolveRegistryCredentials
      ? await Promise.all(targets.map((target) => input.resolveRegistryCredentials!(target.image)))
      : [{ username: input.registryUsername, password: input.registryPassword }];
    const resolvedRegistry = registryResolutions[0];
    if (registryResolutions.some((candidate) =>
      candidate.username !== resolvedRegistry.username || candidate.password !== resolvedRegistry.password
    )) {
      throw new Error("One build cannot mix image targets inside and outside the connected OCI credential scope");
    }
    if (resolvedRegistry.username && resolvedRegistry.password) {
      registryAuth = await dockerLoginRegistry(
        server.ipv4,
        targets[0].image,
        resolvedRegistry.username,
        resolvedRegistry.password,
        hostKey,
      );
    }

    const refs = new Map<string, string>();
    for (const target of targets) {
      const tag = `${target.image}:ocd-${input.commit}`;
      const metadata = `${root}/${target.name}.metadata.json`;
      input.onLog?.(`Building ${target.name} → ${target.image}`);
      const build = await sshExecStreaming(
        server.ipv4,
        asUser(
          `cd ${shellQuote(checkout)} && ${registryAuth?.envPrefix ?? ""}` +
          `docker buildx build --pull --platform linux/amd64 --progress plain --push ` +
          `--label org.opencontainers.image.revision=${shellQuote(input.commit)} ` +
          `--metadata-file ${shellQuote(metadata)} -t ${shellQuote(tag)} ` +
          `-f ${shellQuote(target.dockerfile)} ${shellQuote(target.context)}`,
        ),
        {
          hostKey,
          heartbeatMs: 30_000,
          onLine: (line) => line.trim() && input.onLog?.(`[${target.name}] ${line}`),
          onHeartbeat: (elapsed) => input.onLog?.(`[${target.name}] build still running (${Math.floor(elapsed / 1000)}s)`),
        },
      );
      if (build.exitCode !== 0) throw new Error(`Build failed for ${target.name}: ${(build.stderr || build.stdout).trim().split("\n").slice(-3).join(" | ")}`);
      const digestResult = await sshExec(
        server.ipv4,
        asUser(`jq -r '."containerimage.digest" // empty' ${shellQuote(metadata)}`),
        hostKey,
      );
      const digest = digestResult.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Registry did not return an immutable digest for ${target.name}`);
      const ref = `${target.image}@${digest}`;
      const verify = await sshExec(server.ipv4, asUser(`${registryAuth?.envPrefix ?? ""}docker buildx imagetools inspect ${shellQuote(ref)} >/dev/null`), hostKey);
      if (verify.exitCode !== 0) throw new Error(`Could not verify pushed digest for ${target.name}`);
      refs.set(target.name, ref);
      input.onLog?.(`Published ${ref}`);
    }
    return { refs, files };
  } finally {
    if (registryAuth) await registryAuth.cleanup();
    await sshExec(
      server.ipv4,
      `rm -rf ${shellQuote(root)}; su - deploy -c ${shellQuote("docker image prune -af >/dev/null 2>&1 || true; docker builder prune -af --keep-storage 12GB >/dev/null 2>&1 || true")}`,
      hostKey,
    ).catch(() => {});
  }
}
