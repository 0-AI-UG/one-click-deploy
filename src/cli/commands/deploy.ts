import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import { getGitRepo, readManifest, promptRequired, resolveAuthPassword, manifestHash } from "../manifest.ts";
import { mergeEnv } from "../../shared/env-merge.ts";

interface Environment {
  id: number;
  name: string;
  env_vars?: Array<{ key: string }>;
}

async function resolveEnvironment(name: string): Promise<Environment> {
  const list = await get<Environment[]>("/api/environments");
  const lower = name.toLowerCase();
  const env = list.find((e) => e.name.toLowerCase() === lower);
  if (env) return env;

  console.error(`Environment not found: ${name}`);
  console.error(`Available: ${list.map((e) => e.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function parseFlags(args: string[]): {
  manifestPath: string;
  authPasswordEnv?: string;
  serverId?: number;
  sets: Record<string, string>;
  help: boolean;
  dryRun: boolean;
  configOnly: boolean;
} {
  let manifestPath = "";
  let authPasswordEnv: string | undefined;
  let serverId: number | undefined;
  const sets: Record<string, string> = {};
  let help = false;
  let dryRun = false;
  let configOnly = false;

  for (const arg of args) {
    if (arg.startsWith("--set=")) {
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
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--config-only") {
      configOnly = true;
    } else if (arg.startsWith("--")) {
      console.error(`${RED}Unknown option: ${arg}${RESET}`);
      process.exit(1);
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    }
  }

  if (!manifestPath) manifestPath = ".ocd-deploy.json";

  return { manifestPath, authPasswordEnv, serverId, sets, help, dryRun, configOnly };
}

export async function deploy(args: string[]): Promise<void> {
  if (args[0] === "stack") {
    const { stackUp } = await import("./stack.ts");
    await stackUp(args.slice(1));
    return;
  }

  const { manifestPath, authPasswordEnv, serverId, sets, help, dryRun, configOnly } = parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd deploy [manifest] [options]

Deploys the current git repo using a local .ocd-deploy.json manifest.
Run from inside a git repo with an "origin" remote.

Env vars from the manifest's env[] section are included automatically:
defaults are sent as-is, --set overrides or adds values, and required
vars without a value are prompted for (hidden input when secret).
The manifest's environment field links an environment by name. Use null to
detach; omission retains an existing app's link.

${BOLD}Arguments:${RESET}
  [manifest]                 Path to manifest (default: .ocd-deploy.json)

${BOLD}Subcommands:${RESET}
  stack [manifest]           Deploy a multi-app stack (default: ocd-stack.json)
                             See \`ocd deploy stack --help\`.

${BOLD}Options:${RESET}
  --auth-password-env=<key>  Read the basic-auth password from a local
                             environment variable (never stored in the manifest)
  --server=<id>              Pin this one deploy to a server ID. This is an
                             operational override; use placement_pool in a
                             committed manifest for portable scheduling intent.
  --set=KEY=VALUE            Set an env var (repeatable)
  --dry-run                  Show the desired-configuration diff without applying or deploying
  --config-only              Apply configuration without deploying code`);
    process.exit(0);
  }

  const manifest = readManifest(resolve(manifestPath));
  const repo = manifest.image ? "" : getGitRepo();

  console.log(`${DIM}${manifest.image ? "Image" : "Repo"}:${RESET}    ${manifest.image?.ref || repo}`);
  console.log(`${DIM}Manifest:${RESET} ${manifestPath} ${BOLD}(${manifest.name})${RESET}`);

  const name = manifest.suggested_app_name ||
    (manifest.image ? manifest.image.ref.split("/").pop()!.split("@")[0] : repo.replace(/.*\//, ""));
  const port = manifest.build?.container_port ?? 3000;
  const authPassword = await resolveAuthPassword(manifest.auth, authPasswordEnv);
  const environment = typeof manifest.environment === "string"
    ? await resolveEnvironment(manifest.environment)
    : null;
  if (environment) console.log(`${DIM}Env:${RESET}      ${environment.name}`);

  const webhookEnabled = manifest.webhook?.enabled ?? false;
  let webhookStaging = manifest.webhook?.staging ?? false;
  let webhookStagingEnvironmentId: number | null | undefined;
  const stagingEnvironmentName = manifest.webhook?.staging_environment;
  if (typeof stagingEnvironmentName === "string") {
    if (!webhookEnabled) {
      console.error(`${RED}webhook.staging_environment requires webhook.enabled.${RESET}`);
      process.exit(1);
    }
    const stagingEnvironment = await resolveEnvironment(stagingEnvironmentName);
    webhookStaging = true;
    webhookStagingEnvironmentId = stagingEnvironment.id;
    console.log(`${DIM}Staging:${RESET}  ${stagingEnvironment.name}`);
  } else if (stagingEnvironmentName === null) {
    webhookStaging = false;
    webhookStagingEnvironmentId = null;
  }
  if (webhookStaging && !webhookEnabled) {
    console.error(`${RED}webhook.staging requires webhook.enabled.${RESET}`);
    process.exit(1);
  }
  if (webhookStaging && webhookStagingEnvironmentId === undefined) {
    console.log(`${DIM}Staging:${RESET}  ${name}-staging-env ${DIM}(auto-created)${RESET}`);
  }

  const desiredReplicas = manifest.replicas ?? 1;
  const autoscaling = manifest.autoscaling;
  const minReplicas = autoscaling?.min_replicas ?? 1;
  const maxReplicas = autoscaling?.max_replicas ?? Math.max(desiredReplicas, minReplicas);
  const healthMode = manifest.health_check?.mode ??
    (manifest.health_check?.enabled === false ? "container" : "http");

  const body = {
    apply_mode: "manifest" as const,
    app_name: name,
    git_repo: repo,
    container_port: port,
    domain: manifest.domain,
    git_branch: manifest.git_branch ?? "",
    dockerfile_path: manifest.build?.dockerfile ?? "Dockerfile",
    docker_context: manifest.build?.context ?? ".",
    image_ref: manifest.image?.ref ?? "",
    build_cache_ref: manifest.build?.cache_ref ?? "",
    env_projection: manifest.env_projection ?? null,
    environment_id: environment?.id ??
      (manifest.environment === null ? null : undefined),
    auth_password: authPassword ?? "",
    public: manifest.public ?? true,
    memory_mb: manifest.memory_mb ?? 0,
    cpu_limit: manifest.cpu_limit ?? 0,
    health_check: healthMode === "http",
    health_check_mode: healthMode,
    health_check_path: healthMode === "http" ? (manifest.health_check?.path ?? "") : "",
    health_check_command: manifest.health_check?.command ?? "",
    health_check_file: manifest.health_check?.file ?? "",
    health_check_max_age_seconds: manifest.health_check?.max_age_seconds ?? 0,
    internal_protocol: manifest.internal_protocol ?? "http",
    sticky: manifest.sticky ?? false,
    rate_limit_rps: manifest.rate_limit_rps ?? 0,
    ip_allowlist: manifest.ip_allowlist ?? "",
    compress: manifest.compress ?? false,
    public_port: manifest.public_port ?? null,
    public_protocol: manifest.public_protocol ?? "tcp",
    replicas: desiredReplicas,
    durability_class: manifest.durability_class ?? "none",
    placement_pool: manifest.placement_pool ?? "general",
    scale_to_zero_after: manifest.scale_to_zero_after ?? 0,
    volume_size: manifest.volume?.size ?? 0,
    volume_path: manifest.volume?.path ?? "/data",
    extra_volumes: manifest.extra_volumes ?? [],
    webhook_enabled: webhookEnabled,
    webhook_branch: manifest.webhook?.branch ?? "main",
    webhook_path: manifest.webhook?.path ?? "",
    webhook_wait_for_ci: manifest.webhook?.wait_for_ci ?? false,
    webhook_staging: webhookStaging,
    webhook_staging_environment_id: webhookStagingEnvironmentId,
    autoscale_enabled: autoscaling?.enabled ?? false,
    min_replicas: minReplicas,
    max_replicas: maxReplicas,
    autoscale_cpu_threshold: autoscaling?.cpu_threshold ?? 80,
    autoscale_mem_threshold: autoscaling?.memory_threshold ?? 85,
    autoscale_req_threshold: autoscaling?.requests_per_minute ?? 0,
    autoscale_cooldown: autoscaling?.cooldown_seconds ?? 300,
    manifest_path: manifestPath,
    manifest_hash: manifestHash(resolve(manifestPath)),
    ...(serverId !== undefined ? { server_id: serverId } : {}),
    env_vars: [] as Array<{ key: string; value: string; secret?: boolean }>,
  };

  const existingApps = await get<Array<{ id: number; name: string; environment_id?: number | null; config_revision?: number }>>("/api/apps");
  const existingApp = existingApps.find((a) => a.name === body.app_name);
  let valueEnvironment = environment;
  if (manifest.environment === undefined && existingApp?.environment_id != null) {
    const environments = await get<Environment[]>("/api/environments");
    valueEnvironment = environments.find((candidate) =>
      candidate.id === existingApp.environment_id
    ) ?? null;
  }
  const existingKeys = new Set(
    (valueEnvironment?.env_vars || []).map((value) => value.key),
  );

  const merged = mergeEnv([{ app: body.app_name, defs: manifest.env || [] }], sets, existingKeys);
  const entries = [...merged.entries, ...(await promptRequired(merged.requiredMissing))];
  body.env_vars = entries;

  if (dryRun) {
    const existing = existingApp;
    if (!existing) {
      console.log(`\n${GREEN}Would create ${BOLD}${body.app_name}${RESET} from ${manifestPath}.`);
      return;
    }
    const preview = await post<{
      changes: Array<{ field: string; before: unknown; after: unknown }>;
      current_config_revision: number;
    }>("/api/apps/deploy", { ...body, dry_run: true });
    console.log(`\nConfiguration revision ${preview.current_config_revision}:`);
    if (preview.changes.length === 0) {
      console.log(`  ${DIM}No configuration changes.${RESET}`);
    } else {
      for (const change of preview.changes) {
        console.log(`  ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
      }
    }
    console.log(`\n${DIM}No changes applied; no code deployed.${RESET}`);
    return;
  }

  if (configOnly) {
    const existing = existingApp;
    if (!existing) {
      console.error(`${RED}Cannot apply configuration only: app "${body.app_name}" does not exist.${RESET}`);
      process.exit(1);
    }
    const applied = await post<{
      changes: Array<{ field: string; before: unknown; after: unknown }>;
      config_revision: number;
    }>("/api/apps/deploy", { ...body, deploy: false });
    console.log(`\n${GREEN}Configuration applied.${RESET} Revision ${applied.config_revision}.`);
    for (const change of applied.changes) {
      console.log(`  ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
    }
    console.log(`${DIM}Code was not deployed.${RESET}`);
    return;
  }

  console.log(`\nDeploying ${BOLD}${body.app_name}${RESET}...`);

  const { op_id, changes } = await post<{
    op_id: number;
    changes?: Array<{ field: string; before: unknown; after: unknown }>;
  }>("/api/apps/deploy", body);
  if (changes?.length) {
    console.log(`${DIM}Applied configuration:${RESET}`);
    for (const change of changes) {
      console.log(`  ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
    }
  }

  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Deploy complete!${RESET}`);
  } else {
    console.error(`\n${RED}Deploy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
