import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import { getGitRepo, readManifest, collectEnvVars } from "../manifest.ts";
import type { DeployRequest } from "../../shared/rpc.ts";

interface Environment {
  id: number;
  name: string;
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
  if (manifest.cpu_limit) body.cpu_limit = manifest.cpu_limit;
  // health_check is one nested object in the manifest; the wire request stays
  // flat. Only send the path when the probe isn't disabled, so a contradictory
  // { enabled: false, path } can't reach (and be rejected by) the server.
  if (manifest.health_check?.enabled === false) body.health_check = false;
  if (manifest.internal_protocol) body.internal_protocol = manifest.internal_protocol;
  if (manifest.sticky) body.sticky = true;
  if (manifest.rate_limit_rps !== undefined) body.rate_limit_rps = manifest.rate_limit_rps;
  if (manifest.ip_allowlist) body.ip_allowlist = manifest.ip_allowlist;
  if (manifest.health_check?.enabled !== false && manifest.health_check?.path)
    body.health_check_path = manifest.health_check.path;
  if (manifest.compress) body.compress = true;
  if (manifest.public_port !== undefined) body.public_port = manifest.public_port;
  if (manifest.public_protocol) body.public_protocol = manifest.public_protocol;

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
