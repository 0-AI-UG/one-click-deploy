import type { ServerRow } from "../shared/db/servers.ts";
import { sshExec } from "../shared/remote/index.ts";

export const GITHUB_RUNNER_VERSION = "2.337.0";
export const GITHUB_RUNNER_LABEL = "ocd-builder";
const RUNNER_DIR = "/opt/ocd-actions-runner";
const RUNNER_UNIT = "ocd-github-runner.service";

const RUNNER_ASSETS = {
  x64: {
    sha256: "70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613",
    archive: `actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz`,
  },
  arm64: {
    sha256: "9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393",
    archive: `actions-runner-linux-arm64-${GITHUB_RUNNER_VERSION}.tar.gz`,
  },
} as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function encodeFile(contents: string): string {
  return Buffer.from(contents, "utf8").toString("base64");
}

export function normalizeGitHubRunnerScope(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 1 || parts.length > 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) return null;
    return `https://github.com/${parts.join("/")}`;
  } catch {
    return null;
  }
}

export function normalizeGitHubRunnerName(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(trimmed) ? trimmed : null;
}

export function validGitHubRunnerToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(value.trim());
}

function runnerUnit(): string {
  return `[Unit]\nDescription=OCD GitHub Actions build runner\nAfter=network-online.target docker.service\nWants=network-online.target\nRequires=docker.service\n\n[Service]\nUser=ocd-runner\nGroup=ocd-runner\nSupplementaryGroups=docker\nWorkingDirectory=${RUNNER_DIR}\nEnvironment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${RUNNER_DIR}/ocd-post-job.sh\nExecStart=${RUNNER_DIR}/run.sh\nKillSignal=SIGINT\nTimeoutStopSec=120\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function postJobHook(): string {
  return `#!/usr/bin/env bash\nset -u\nexec 9>/var/lock/ocd-github-runner-gc.lock\nflock -n 9 || exit 0\ndocker builder prune -af --filter until=24h >/dev/null 2>&1 || true\ndocker image prune -af --filter until=24h >/dev/null 2>&1 || true\n`;
}

/** Build a checksum-pinned, non-interactive installer for GitHub's official runner. */
export function buildInstallGitHubRunnerScript(input: {
  scopeUrl: string;
  registrationToken: string;
  runnerName: string;
}): string {
  const scopeUrl = normalizeGitHubRunnerScope(input.scopeUrl);
  const runnerName = normalizeGitHubRunnerName(input.runnerName);
  if (!scopeUrl) throw new Error("Invalid GitHub runner scope URL");
  if (!runnerName) throw new Error("Invalid GitHub runner name");
  if (!validGitHubRunnerToken(input.registrationToken)) throw new Error("Invalid GitHub runner registration token");

  const x64 = RUNNER_ASSETS.x64;
  const arm64 = RUNNER_ASSETS.arm64;
  const unit = encodeFile(runnerUnit());
  const hook = encodeFile(postJobHook());
  return [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "case \"$(uname -m)\" in",
    `  x86_64) runner_arch=x64; runner_archive=${shellQuote(x64.archive)}; runner_sha=${shellQuote(x64.sha256)} ;;`,
    `  aarch64|arm64) runner_arch=arm64; runner_archive=${shellQuote(arm64.archive)}; runner_sha=${shellQuote(arm64.sha256)} ;;`,
    "  *) echo 'Unsupported runner architecture' >&2; exit 41 ;;",
    "esac",
    "command -v docker >/dev/null && docker info >/dev/null",
    "command -v curl >/dev/null && command -v tar >/dev/null && command -v sha256sum >/dev/null",
    "getent group docker >/dev/null",
    "id ocd-runner >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/ocd-runner --shell /bin/bash ocd-runner",
    "usermod -aG docker ocd-runner",
    `install -d -o ocd-runner -g ocd-runner -m 0750 ${RUNNER_DIR}`,
    `if [ ! -x ${RUNNER_DIR}/run.sh ]; then`,
    `  tmp_archive=$(mktemp /tmp/ocd-actions-runner.XXXXXX.tar.gz)`,
    "  trap 'rm -f \"$tmp_archive\"' EXIT",
    `  curl --fail --location --retry 3 --retry-delay 2 --output "$tmp_archive" "https://github.com/actions/runner/releases/download/v${GITHUB_RUNNER_VERSION}/$runner_archive"`,
    "  printf '%s  %s\\n' \"$runner_sha\" \"$tmp_archive\" | sha256sum -c -",
    `  tar -xzf "$tmp_archive" -C ${RUNNER_DIR}`,
    `  chown -R ocd-runner:ocd-runner ${RUNNER_DIR}`,
    `  ${RUNNER_DIR}/bin/installdependencies.sh >/dev/null`,
    "  rm -f \"$tmp_archive\"",
    "  trap - EXIT",
    "fi",
    `printf '%s' ${shellQuote(hook)} | base64 -d > ${RUNNER_DIR}/ocd-post-job.sh`,
    `chown ocd-runner:ocd-runner ${RUNNER_DIR}/ocd-post-job.sh && chmod 0750 ${RUNNER_DIR}/ocd-post-job.sh`,
    `if [ ! -f ${RUNNER_DIR}/.runner ]; then`,
    `  cd ${RUNNER_DIR}`,
    `  runuser -u ocd-runner -- ./config.sh --unattended --url ${shellQuote(scopeUrl)} --token ${shellQuote(input.registrationToken.trim())} --name ${shellQuote(runnerName)} --labels ${GITHUB_RUNNER_LABEL} --work _work`,
    "fi",
    `printf '%s' ${shellQuote(unit)} | base64 -d > /etc/systemd/system/${RUNNER_UNIT}`,
    `chmod 0644 /etc/systemd/system/${RUNNER_UNIT}`,
    "systemctl daemon-reload",
    `systemctl enable --now ${RUNNER_UNIT}`,
    "sleep 2",
    `systemctl is-active --quiet ${RUNNER_UNIT}`,
    `version=$(${RUNNER_DIR}/bin/Runner.Listener --version | tail -1 | tr -d '\\r')`,
    "printf 'OCD_RUNNER_READY\\t%s\\t%s\\n' \"$version\" \"$runner_arch\"",
  ].join("\n");
}

export function buildRemoveGitHubRunnerScript(removalToken: string): string {
  if (!validGitHubRunnerToken(removalToken)) throw new Error("Invalid GitHub runner removal token");
  return [
    "set -euo pipefail",
    `if [ ! -d ${RUNNER_DIR} ]; then exit 0; fi`,
    `systemctl stop ${RUNNER_UNIT} 2>/dev/null || true`,
    `if [ -f ${RUNNER_DIR}/.runner ]; then`,
    `  cd ${RUNNER_DIR}`,
    `  if ! runuser -u ocd-runner -- ./config.sh remove --token ${shellQuote(removalToken.trim())}; then`,
    `    systemctl start ${RUNNER_UNIT} 2>/dev/null || true`,
    "    exit 42",
    "  fi",
    "fi",
    `systemctl disable ${RUNNER_UNIT} 2>/dev/null || true`,
    `rm -f /etc/systemd/system/${RUNNER_UNIT}`,
    "systemctl daemon-reload",
    `rm -rf -- ${RUNNER_DIR}`,
  ].join("\n");
}

export type GitHubRunnerProbe = {
  online: boolean;
  configured: boolean;
  version: string;
  architecture: string;
  diskFreeBytes: number;
  error: string;
};

export async function probeGitHubRunner(server: ServerRow): Promise<GitHubRunnerProbe> {
  const result = await sshExec(
    server.management_address || server.ipv4,
    [
      `active=$(systemctl is-active ${RUNNER_UNIT} 2>/dev/null || true)`,
      `configured=0; [ -f ${RUNNER_DIR}/.runner ] && configured=1`,
      `version=''; [ -x ${RUNNER_DIR}/bin/Runner.Listener ] && version=$(${RUNNER_DIR}/bin/Runner.Listener --version 2>/dev/null | tail -1 | tr -d '\\r') || true`,
      "arch=$(uname -m)",
      "free=$(df -B1 --output=avail / | tail -1 | tr -d ' ')",
      "printf 'OCD_RUNNER_PROBE\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$active\" \"$configured\" \"$version\" \"$arch\" \"$free\"",
    ].join("\n"),
    server.ssh_host_key || undefined,
    { user: server.ssh_user || "root", port: server.ssh_port || 22 },
  );
  if (result.exitCode !== 0) {
    return { online: false, configured: false, version: "", architecture: "", diskFreeBytes: 0, error: result.stderr.trim() || "SSH probe failed" };
  }
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("OCD_RUNNER_PROBE\t"));
  const fields = line?.split("\t") ?? [];
  if (fields.length !== 6) {
    return { online: false, configured: false, version: "", architecture: "", diskFreeBytes: 0, error: "Runner probe returned malformed output" };
  }
  return {
    online: fields[1] === "active",
    configured: fields[2] === "1",
    version: fields[3],
    architecture: fields[4],
    diskFreeBytes: Math.max(0, Number(fields[5]) || 0),
    error: "",
  };
}

export async function runGitHubRunnerInstall(server: ServerRow, script: string) {
  return sshExec(
    server.management_address || server.ipv4,
    script,
    server.ssh_host_key || undefined,
    { user: server.ssh_user || "root", port: server.ssh_port || 22 },
  );
}

export async function getGitHubRunnerLogs(server: ServerRow, tail = 200): Promise<string> {
  const safeTail = Math.min(1000, Math.max(1, Math.floor(tail)));
  const result = await sshExec(
    server.management_address || server.ipv4,
    `journalctl -u ${RUNNER_UNIT} -n ${safeTail} --no-pager --output=short-iso`,
    server.ssh_host_key || undefined,
    { user: server.ssh_user || "root", port: server.ssh_port || 22 },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not read runner logs");
  return result.stdout;
}
