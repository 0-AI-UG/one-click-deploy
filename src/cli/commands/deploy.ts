import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import { promptLine, promptHidden } from "../prompt.ts";
import type { DeployManifest, DeployRequest } from "../../shared/rpc.ts";

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

function parseFlags(args: string[]): {
  manifestPath: string;
  domain?: string;
  envName?: string;
  sets: Record<string, string>;
  help: boolean;
} {
  let manifestPath = "";
  let domain: string | undefined;
  let envName: string | undefined;
  const sets: Record<string, string> = {};
  let help = false;

  for (const arg of args) {
    if (arg.startsWith("--domain=")) {
      domain = arg.slice(9);
    } else if (arg.startsWith("--env=")) {
      envName = arg.slice(6);
    } else if (arg.startsWith("--set=")) {
      const pair = arg.slice(6);
      const eq = pair.indexOf("=");
      if (eq < 1) {
        console.error(`${RED}Invalid --set value (expected --set=KEY=VALUE): ${arg}${RESET}`);
        process.exit(1);
      }
      sets[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) manifestPath = ".ocd-deploy.json";

  return { manifestPath, domain, envName, sets, help };
}

// Resolve the manifest's env[] section into concrete values: --set overrides,
// then manifest defaults, then interactive prompts for required vars.
async function collectEnvVars(
  manifest: DeployManifest,
  sets: Record<string, string>,
): Promise<Array<{ key: string; value: string; secret?: boolean }>> {
  const out: Array<{ key: string; value: string; secret?: boolean }> = [];
  const remaining = { ...sets };

  const toPrompt: NonNullable<DeployManifest["env"]> = [];
  for (const entry of manifest.env || []) {
    if (entry.key in remaining) {
      out.push({ key: entry.key, value: remaining[entry.key], secret: entry.secret });
      delete remaining[entry.key];
    } else if (entry.default !== undefined) {
      out.push({ key: entry.key, value: entry.default, secret: entry.secret });
    } else if (entry.required) {
      toPrompt.push(entry);
    }
  }

  // Extra --set keys not declared in the manifest
  for (const [key, value] of Object.entries(remaining)) {
    out.push({ key, value });
  }

  if (toPrompt.length > 0) {
    if (!process.stdin.isTTY) {
      console.error(
        `${RED}Missing required env vars: ${toPrompt.map((e) => e.key).join(", ")}${RESET}`,
      );
      console.error(`Provide them with --set=KEY=VALUE or link an environment with --env=<name|id>.`);
      process.exit(1);
    }
    console.log(`\n${BOLD}Required environment variables${RESET}`);
    for (const entry of toPrompt) {
      const hint = entry.description ? ` ${DIM}(${entry.description})${RESET}` : "";
      const question = `  ${entry.key}${hint}: `;
      let value = "";
      while (!value) {
        value = entry.secret ? await promptHidden(question) : await promptLine(question);
      }
      out.push({ key: entry.key, value, secret: entry.secret });
    }
  }

  return out;
}

export async function deploy(args: string[]): Promise<void> {
  const { manifestPath, domain, envName, sets, help } = parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd deploy [manifest] [options]

Deploys the current git repo using a local .ocd-deploy.json manifest.
Run from inside a git repo with an "origin" remote.

Env vars from the manifest's env[] section are included automatically:
defaults are sent as-is, --set overrides or adds values, and required
vars without a value are prompted for (hidden input when secret).
With --env, the linked environment supplies all variables instead.

${BOLD}Arguments:${RESET}
  [manifest]                 Path to manifest (default: .ocd-deploy.json)

${BOLD}Options:${RESET}
  --domain=<domain>          Custom domain
  --env=<name|id>            Link to an existing environment
  --set=KEY=VALUE            Set an env var (repeatable)`);
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

  if (manifest.webhook?.enabled) {
    body.webhook_enabled = true;
    body.webhook_branch = manifest.webhook.branch || "main";
    if (manifest.webhook.path) body.webhook_path = manifest.webhook.path;
    if (manifest.webhook.wait_for_ci) body.webhook_wait_for_ci = true;
  }

  if (manifest.replicas) body.replicas = manifest.replicas;
  if (manifest.public !== undefined) body.public = manifest.public;
  if (manifest.memory_mb) body.memory_mb = manifest.memory_mb;
  if (manifest.health_check === false) body.health_check = false;

  if (manifest.volume?.size) {
    body.volume_size = manifest.volume.size;
    body.volume_path = manifest.volume.path || "/data";
  }

  if (manifest.extra_volumes?.length) body.extra_volumes = manifest.extra_volumes;

  if (envName) {
    // The server ignores env_vars when environment_id is set — the linked
    // environment supplies all variables, so skip manifest env collection.
    const env = await resolveEnvironment(envName);
    body.environment_id = env.id;
    console.log(`${DIM}Env:${RESET}      ${env.name}`);
  } else {
    const envVars = await collectEnvVars(manifest, sets);
    if (envVars.length > 0) body.env_vars = envVars;
  }

  console.log(`\nDeploying ${BOLD}${name}${RESET}...`);

  const { op_id } = await post<{ op_id: number }>("/api/apps/deploy", body);

  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Deploy complete!${RESET}`);
  } else {
    console.error(`\n${RED}Deploy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
