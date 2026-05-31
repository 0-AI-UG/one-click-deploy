import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET } from "../format.ts";
import type { DeployManifest, DeployRequest } from "../../shared/rpc.ts";

interface OperationEventPoll {
  status: "pending" | "running" | "done" | "failed" | "compensating" | "compensated" | "cancelled";
  last_step: string | null;
  error: { message?: string; cancelled?: boolean } | null;
  steps: Array<{
    seq: number;
    step: string;
    phase: "forward" | "compensate";
    status: "started" | "ok" | "skipped" | "failed";
    detail: string;
  }>;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "compensated"]);

interface Environment {
  id: number;
  name: string;
}

function getGitRepo(): string {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
    const sshMatch = url.match(/^git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;
    return url.replace(/\.git$/, "");
  } catch {
    console.error(`${RED}Not a git repository (or no remote "origin" configured)${RESET}`);
    process.exit(1);
  }
}

function readManifest(path: string): DeployManifest {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as DeployManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${RED}Manifest not found: ${path}${RESET}`);
    } else {
      console.error(`${RED}Failed to read manifest: ${err instanceof Error ? err.message : err}${RESET}`);
    }
    process.exit(1);
  }
}

async function resolveEnvironment(nameOrId: string): Promise<Environment> {
  const list = await get<Environment[]>("/api/environments");

  const id = parseInt(nameOrId, 10);
  if (!isNaN(id)) {
    const env = list.find((e) => e.id === id);
    if (env) return env;
  }

  const lower = nameOrId.toLowerCase();
  const env = list.find((e) => e.name.toLowerCase() === lower);
  if (env) return env;

  console.error(`Environment not found: ${nameOrId}`);
  console.error(`Available: ${list.map((e) => e.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function parseFlags(args: string[]): { manifestPath: string; domain?: string; envName?: string; help: boolean } {
  let manifestPath = "";
  let domain: string | undefined;
  let envName: string | undefined;
  let help = false;

  for (const arg of args) {
    if (arg.startsWith("--domain=")) {
      domain = arg.slice(9);
    } else if (arg.startsWith("--env=")) {
      envName = arg.slice(6);
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) manifestPath = ".ocd-deploy.json";

  return { manifestPath, domain, envName, help };
}

export async function deploy(args: string[]): Promise<void> {
  const { manifestPath, domain, envName, help } = parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd deploy [manifest] [options]

Deploys the current git repo using a local .ocd-deploy.json manifest.
Run from inside a git repo with an "origin" remote.

${BOLD}Arguments:${RESET}
  [manifest]                 Path to manifest (default: .ocd-deploy.json)

${BOLD}Options:${RESET}
  --domain=<domain>          Custom domain
  --env=<name|id>            Link to an existing environment`);
    process.exit(0);
  }

  const repo = getGitRepo();
  const manifest = readManifest(resolve(manifestPath));

  console.log(`${DIM}Repo:${RESET}     ${repo}`);
  console.log(`${DIM}Manifest:${RESET} ${manifestPath} ${BOLD}(${manifest.name})${RESET}`);

  const name = manifest.suggested_app_name || repo.replace(/.*\//, "");
  const port = manifest.build?.container_port ?? 3000;

  const body: DeployRequest = {
    app_name: name,
    git_repo: repo,
    container_port: port,
  };

  if (domain) body.domain = domain;
  if (manifest.build?.dockerfile) body.dockerfile_path = manifest.build.dockerfile;
  if (manifest.build?.context) body.docker_context = manifest.build.context;
  if (manifest.build?.compose_file) body.compose_file = manifest.build.compose_file;
  if (manifest.build?.compose_web_service) body.compose_web_service = manifest.build.compose_web_service;

  if (manifest.webhook?.enabled) {
    body.webhook_enabled = true;
    body.webhook_branch = manifest.webhook.branch || "main";
    if (manifest.webhook.path) body.webhook_path = manifest.webhook.path;
    if (manifest.webhook.wait_for_ci) body.webhook_wait_for_ci = true;
  }

  if (manifest.replicas) body.replicas = manifest.replicas;
  if (manifest.public !== undefined) body.public = manifest.public;
  if (manifest.memory_mb) body.memory_mb = manifest.memory_mb;

  if (manifest.volume?.size) {
    body.volume_size = manifest.volume.size;
    body.volume_path = manifest.volume.path || "/data";
  }

  if (manifest.extra_volumes?.length) body.extra_volumes = manifest.extra_volumes;

  if (envName) {
    const env = await resolveEnvironment(envName);
    body.environment_id = env.id;
    console.log(`${DIM}Env:${RESET}      ${env.name}`);
  }

  console.log(`\nDeploying ${BOLD}${name}${RESET}...`);

  const { op_id } = await post<{ op_id: number }>("/api/apps/deploy", body);

  let lastSeq = 0;
  while (true) {
    const poll = await get<OperationEventPoll>(
      `/api/operations/${op_id}/events?since=${lastSeq}&wait=15000`,
    );

    for (const event of poll.steps) {
      // Only surface forward-phase starts once per step (mirrors prior UX).
      if (event.phase === "compensate") {
        const step = `rollback ${event.step}`.padEnd(22);
        console.log(`  ${RED}${step}${RESET} ${event.detail || event.status}`);
      } else {
        const step = event.step.padEnd(22);
        if (event.status === "failed") {
          console.log(`  ${RED}${step}${RESET} ${event.detail}`);
        } else if (event.status === "ok" || event.status === "skipped") {
          console.log(`  ${GREEN}${step}${RESET} ${event.status === "skipped" ? "(skipped) " : ""}${event.detail}`);
        } else {
          console.log(`  ${CYAN}${step}${RESET} ${event.detail || "…"}`);
        }
      }
      lastSeq = event.seq;
    }

    if (TERMINAL.has(poll.status)) {
      if (poll.status === "done") {
        console.log(`\n${GREEN}Deploy complete!${RESET}`);
      } else {
        const msg = poll.error?.message || poll.status;
        console.error(`\n${RED}Deploy ${poll.status}: ${msg}${RESET}`);
        process.exit(1);
      }
      break;
    }
  }
}
