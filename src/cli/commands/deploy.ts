import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import { getGitRepo, readManifest, promptRequired, resolveAuthPassword } from "../manifest.ts";
import { mergeEnv } from "../../shared/env-merge.ts";
import type { DeployRequest } from "../../shared/rpc.ts";

interface Environment {
  id: number;
  name: string;
  env_vars?: Array<{ key: string }>;
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
  stagingEnvName?: string;
  authPasswordEnv?: string;
  serverId?: number;
  sets: Record<string, string>;
  help: boolean;
} {
  let manifestPath = "";
  let domain: string | undefined;
  let envName: string | undefined;
  let stagingEnvName: string | undefined;
  let authPasswordEnv: string | undefined;
  let serverId: number | undefined;
  const sets: Record<string, string> = {};
  let help = false;

  for (const arg of args) {
    if (arg.startsWith("--domain=")) {
      domain = arg.slice(9);
    } else if (arg.startsWith("--env=")) {
      envName = arg.slice(6);
    } else if (arg.startsWith("--staging-env=")) {
      stagingEnvName = arg.slice(14);
    } else if (arg.startsWith("--set=")) {
      const pair = arg.slice(6);
      const eq = pair.indexOf("=");
      if (eq < 1) {
        console.error(`${RED}Invalid --set value (expected --set=KEY=VALUE): ${arg}${RESET}`);
        process.exit(1);
      }
      sets[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg.startsWith("--auth-password-env=")) {
      authPasswordEnv = arg.slice(20);
    } else if (arg.startsWith("--server=")) {
      const raw = arg.slice(9);
      serverId = Number(raw);
      if (!Number.isInteger(serverId) || serverId < 1) {
        console.error(`${RED}Invalid --server value (expected a positive numeric ID): ${raw}${RESET}`);
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--")) {
      console.error(`${RED}Unknown option: ${arg}${RESET}`);
      process.exit(1);
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) manifestPath = ".ocd-deploy.json";

  return { manifestPath, domain, envName, stagingEnvName, authPasswordEnv, serverId, sets, help };
}

export async function deploy(args: string[]): Promise<void> {
  if (args[0] === "stack") {
    const { stackUp } = await import("./stack.ts");
    await stackUp(args.slice(1));
    return;
  }

  const { manifestPath, domain, envName, stagingEnvName, authPasswordEnv, serverId, sets, help } = parseFlags(args);

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

${BOLD}Subcommands:${RESET}
  stack [manifest]           Deploy a multi-app stack (default: ocd-stack.json)
                             Takes --env, --set=<app>.KEY=VALUE and
                             --staging-env (one per stack) — see
                             \`ocd deploy stack --help\`.

${BOLD}Options:${RESET}
  --domain=<domain>          Custom domain
  --env=<name|id>            Link an existing environment (env-var bag) by
                             name or id
  --staging-env=<name|id>    Enable webhook staging: pushes deploy to the
                             <name>-staging sibling (with this environment) and
                             hold for manual promotion. Requires webhook.enabled.
  --auth-password-env=<key>  Read the basic-auth password from a local
                             environment variable (never stored in the manifest)
  --server=<id>              Pin this one deploy to a server ID. This is an
                             operational override; use placement_pool in a
                             committed manifest for portable scheduling intent.
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

  if (manifest.domain) body.domain = manifest.domain;
  if (domain) body.domain = domain;
  if (manifest.git_branch) body.git_branch = manifest.git_branch;
  if (manifest.env_projection !== undefined) body.env_projection = manifest.env_projection;
  const authPassword = await resolveAuthPassword(manifest.auth, authPasswordEnv);
  if (authPassword !== undefined) body.auth_password = authPassword;
  if (serverId !== undefined) body.server_id = serverId;
  if (manifest.build?.dockerfile) body.dockerfile_path = manifest.build.dockerfile;
  if (manifest.build?.context) body.docker_context = manifest.build.context;

  if (manifest.webhook?.enabled) {
    body.webhook_enabled = true;
    body.webhook_branch = manifest.webhook.branch || "main";
    if (manifest.webhook.path) body.webhook_path = manifest.webhook.path;
    if (manifest.webhook.wait_for_ci) body.webhook_wait_for_ci = true;
  }

  // Webhook staging is opt-in via the manifest (`webhook.staging`). Naming an
  // environment is OPTIONAL: with --staging-env we link that one, otherwise the
  // deploy op mints `<app>-staging-env` as a copy of the app's environment —
  // the same deal the app's production environment gets when --env is omitted.
  if (stagingEnvName) {
    if (!body.webhook_enabled) {
      console.error(`${RED}--staging-env requires webhooks — set "webhook": { "enabled": true } in the manifest.${RESET}`);
      process.exit(1);
    }
    const stagingEnv = await resolveEnvironment(stagingEnvName);
    body.webhook_staging_environment_id = stagingEnv.id;
    console.log(`${DIM}Staging:${RESET}  ${stagingEnv.name}`);
  } else if (manifest.webhook?.staging && body.webhook_enabled) {
    body.webhook_staging = true;
    console.log(`${DIM}Staging:${RESET}  ${name}-staging-env ${DIM}(auto-created)${RESET}`);
  } else if (manifest.webhook?.staging) {
    // Only reachable with staging on and the webhook off. Staging holds PUSHED
    // commits, so without the webhook nothing would ever reach it.
    console.error(`${RED}webhook.staging requires webhooks — set "webhook": { "enabled": true } in the manifest.${RESET}`);
    process.exit(1);
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

  // Durability policy applies to every path.
  if (manifest.durability_class) body.durability_class = manifest.durability_class;
  if (manifest.placement_pool) body.placement_pool = manifest.placement_pool;
  if (manifest.scale_to_zero_after !== undefined)
    body.scale_to_zero_after = manifest.scale_to_zero_after;

  // Unified env resolution: manifest defaults + --set, layered on top of a
  // linked environment when one is given. Existing env values win; --set
  // overrides everything.
  let existingKeys = new Set<string>();

  if (envName) {
    const env = await resolveEnvironment(envName);
    body.environment_id = env.id;
    existingKeys = new Set((env.env_vars || []).map((v) => v.key));
    console.log(`${DIM}Env:${RESET}      ${env.name}`);
  }

  const merged = mergeEnv([{ app: body.app_name, defs: manifest.env || [] }], sets, existingKeys);
  const entries = [...merged.entries, ...(await promptRequired(merged.requiredMissing))];
  if (entries.length > 0) body.env_vars = entries;

  console.log(`\nDeploying ${BOLD}${body.app_name}${RESET}...`);

  const { op_id } = await post<{ op_id: number }>("/api/apps/deploy", body);

  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Deploy complete!${RESET}`);
  } else {
    console.error(`\n${RED}Deploy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
