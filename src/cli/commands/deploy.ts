import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import {
  manifestRepoLocation,
  readManifest,
  promptRequired,
  resolveAuthPassword,
  manifestHash,
  localGitCommit,
} from "../manifest.ts";
import { mergeEnv } from "../../shared/env-merge.ts";
import { withWebConfirmation } from "../confirm.ts";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";
import { readSetValuesFromStdin } from "../stdin-values.ts";
import { ensureBuildReadiness } from "../deploy-readiness.ts";

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

async function parseFlags(args: string[]): Promise<{
  manifestPath: string;
  authPasswordEnv?: string;
  serverId?: number;
  appName?: string;
  sets: Record<string, string>;
  help: boolean;
  dryRun: boolean;
  configOnly: boolean;
  allowUnknown: boolean;
  commit?: string;
}> {
  const parsed = parseCliArgs(args, {
    set: { type: "string", repeatable: true },
    "auth-password-env": { type: "string" },
    server: { type: "string" },
    app: { type: "string" },
    help: { type: "boolean", aliases: ["h"] },
    "dry-run": { type: "boolean" },
    "config-only": { type: "boolean" },
    "allow-unknown": { type: "boolean" },
    commit: { type: "string" },
    "sets-stdin": { type: "boolean" },
  }, { maxPositionals: 1 });
  const manifestPath = parsed.positionals[0] || ".ocd-deploy.json";
  const authPasswordEnv = parsed.flags["auth-password-env"] as string | undefined;
  const serverId = positiveIntegerFlag(parsed.flags.server, "server");
  const appName = parsed.flags.app as string | undefined;
  const commit = parsed.flags.commit as string | undefined;
  if (commit !== undefined && !/^[a-f0-9]{7,64}$/i.test(commit)) {
    throw new Error("--commit must contain 7-64 hexadecimal characters");
  }
  const stdinSets = parsed.flags["sets-stdin"] === true ? (await readSetValuesFromStdin()).sets : [];
  const sets: Record<string, string> = {};
  for (const pair of [...((parsed.flags.set as string[] | undefined) ?? []), ...stdinSets]) {
      const eq = pair.indexOf("=");
      if (eq < 1) {
        throw new Error(`Invalid --set value (expected KEY=VALUE): ${pair}`);
      }
      sets[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return {
    manifestPath, authPasswordEnv, serverId, appName, sets, commit,
    help: parsed.flags.help === true,
    dryRun: parsed.flags["dry-run"] === true,
    configOnly: parsed.flags["config-only"] === true,
    allowUnknown: parsed.flags["allow-unknown"] === true,
  };
}

export async function deploy(args: string[]): Promise<void> {
  if (args[0] === "stack") {
    const { stackUp } = await import("./stack.ts");
    await stackUp(args.slice(1));
    return;
  }

  const { manifestPath, authPasswordEnv, serverId, appName, sets, help, dryRun, configOnly, allowUnknown, commit } = await parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd deploy [manifest] [options]

Deploys the manifest's declared source. OCD either builds the current Git
commit and pushes it to build.image_repository, or resolves a prebuilt image
reference. The runtime always receives an immutable registry digest.

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
  --app=<name>               Apply to an explicit existing app while retaining
                             its stored environment and stack association.
  --set=KEY=VALUE            Set an env var (repeatable)
  --commit=<sha>             Record the source revision as deployment provenance
  --dry-run                  Show the desired-configuration diff without applying or deploying
  --config-only              Apply config; runtime changes reuse the current image
  --allow-unknown            Compatibility escape hatch for newer manifest keys`);
    process.exit(0);
  }

  const location = manifestRepoLocation(manifestPath);
  const manifest = readManifest(location.fullPath, { allowUnknown });
  const sourceCommit = commit ?? localGitCommit(location.fullPath);
  if (manifest.build) {
    console.log(`${DIM}Build:${RESET}    ${manifest.build.repository}#${sourceCommit.slice(0, 12)}`);
  }
  console.log(`${DIM}Image:${RESET}    ${manifest.image ?? manifest.build?.image_repository}`);
  console.log(`${DIM}Manifest:${RESET} ${location.path} ${BOLD}(${manifest.name})${RESET}`);

  const name = appName || manifest.suggested_app_name ||
    (manifest.image ?? manifest.build!.image_repository).split("/").pop()!.split("@")[0].split(":")[0];
  const port = manifest.container_port ?? 3000;
  const authPassword = await resolveAuthPassword(manifest.auth, authPasswordEnv);
  const environment = typeof manifest.environment === "string"
    ? await resolveEnvironment(manifest.environment)
    : null;
  if (environment) console.log(`${DIM}Env:${RESET}      ${environment.name}`);

  const desiredReplicas = manifest.replicas ?? 1;
  const autoscaling = manifest.autoscaling;
  const minReplicas = autoscaling?.min_replicas ?? 1;
  const maxReplicas = autoscaling?.max_replicas ?? Math.max(desiredReplicas, minReplicas);
  const healthMode = manifest.health_check?.mode ??
    (manifest.health_check?.enabled === false ? "container" : "http");

  const body = {
    apply_mode: "manifest" as const,
    app_name: name,
    delivery_source: manifest.build ? "build" as const : "image" as const,
    container_port: port,
    domain: manifest.domain,
    image_ref: manifest.image,
    build: manifest.build,
    git_commit: sourceCommit,
    env_projection: manifest.env_projection ?? null,
    environment_id: environment?.id ??
      (manifest.environment === null ? null : undefined),
    auth_password: authPassword ?? "",
    public: manifest.public ?? true,
    memory_mb: manifest.memory_mb ?? 0,
    cpu_limit: manifest.cpu_limit ?? 0,
    command: manifest.command ?? [],
    cap_add: manifest.cap_add ?? [],
    post_start_command: manifest.post_start?.command ?? "",
    health_check: healthMode === "http",
    health_check_mode: healthMode,
    health_check_path: healthMode === "http" ? (manifest.health_check?.path ?? "") : "",
    health_check_command: manifest.health_check?.command ?? "",
    health_check_file: manifest.health_check?.file ?? "",
    health_check_max_age_seconds: manifest.health_check?.max_age_seconds ?? 0,
    health_check_expected_statuses: manifest.health_check?.expected_statuses ?? [200],
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
    volume_id: manifest.volume?.id ?? "",
    volume_driver: manifest.volume?.driver,
    volume_size: manifest.volume?.size ?? 0,
    volume_path: manifest.volume?.path ?? "/data",
    extra_volumes: manifest.extra_volumes ?? [],
    autoscale_enabled: autoscaling?.enabled ?? false,
    min_replicas: minReplicas,
    max_replicas: maxReplicas,
    autoscale_cpu_threshold: autoscaling?.cpu_threshold ?? 80,
    autoscale_mem_threshold: autoscaling?.memory_threshold ?? 85,
    autoscale_req_threshold: autoscaling?.requests_per_minute ?? 0,
    autoscale_cooldown: autoscaling?.cooldown_seconds ?? 300,
    manifest_path: location.path,
    manifest_hash: manifestHash(location.fullPath),
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
      op_id: number;
      rollout?: "control" | "runtime";
      pending_rollout?: boolean;
    }>("/api/apps/deploy", { ...body, deploy: false });
    const result = await followOp(applied.op_id);
    if (!result.ok) {
      console.error(`\n${RED}Manifest reconciliation failed: ${result.error || "unknown error"}${RESET}`);
      process.exit(1);
    }
    console.log(`\n${GREEN}Configuration applied.${RESET} Revision ${applied.config_revision}.`);
    for (const change of applied.changes) {
      console.log(`  ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
    }
    if (applied.rollout === "runtime") {
      console.log(`${DIM}Containers were recreated from the existing immutable image.${RESET}`);
    } else {
      console.log(`${DIM}No container rollout was required.${RESET}`);
    }
    return;
  }

  if (manifest.build && !configOnly) {
    await ensureBuildReadiness(manifest.build.repository, manifest.build.image_repository);
  }

  console.log(`\nDeploying ${BOLD}${body.app_name}${RESET}...`);

  const { op_id, changes } = await withWebConfirmation((headers) =>
    post<{
      op_id: number;
      changes?: Array<{ field: string; before: unknown; after: unknown }>;
    }>("/api/apps/deploy", body, headers)
  );
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
