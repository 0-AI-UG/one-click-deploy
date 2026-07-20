import { resolve } from "node:path";
import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET } from "../format.ts";
import { getGitRepo, readManifest, promptRequired } from "../manifest.ts";
import { mergeEnv } from "../../shared/env-merge.ts";
import type { DeployRequest, DeployManifest } from "../../shared/rpc.ts";

/** Target-specific DeployRequest fields derived from a manifest's `targets`
 *  block. Pure data — the caller applies it to the wire request. */
export interface DerivedTarget {
  app_name: string;
  target: string;
  git_branch: string;
  replicas?: number;
  domain?: string;
  scale_to_zero_after?: number;
  placement_pool?: string;
  /** true when the target is "production" (bare app name, no isolation). */
  isProduction: boolean;
}

export type DeriveTargetResult =
  | { ok: true; value: DerivedTarget | null }
  | { ok: false; error: string; hint: string };

/**
 * Pure derivation of the deploy-target fields for `ocd deploy [--target=<t>]`.
 * A "production" target (and no other) keeps the bare app name; other targets
 * become a `<name>-<target>` sibling. Branch precedence: the target's branch,
 * else the manifest webhook branch, else "main". Non-production targets are
 * isolated by default (placement_pool "staging") unless `isolated: false`.
 * No --target flag: when the manifest declares `targets.production`, a plain
 * deploy applies that target (identical derivation to --target=production so
 * the two paths can't drift); otherwise `value: null` means "no target
 * semantics apply".
 */
export function deriveTarget(
  manifest: Pick<DeployManifest, "targets" | "webhook">,
  targetName: string | undefined,
  name: string,
): DeriveTargetResult {
  const targets = manifest.targets || {};
  if (!targetName) {
    // Plain deploy defaults to the declared production target (if any).
    if (!targets.production) return { ok: true, value: null };
    targetName = "production";
  }
  const t = targets[targetName];
  if (!t) {
    const declared = Object.keys(targets);
    return {
      ok: false,
      error: `Unknown target "${targetName}".`,
      hint: declared.length
        ? `Declared targets: ${declared.join(", ")}`
        : `The manifest has no "targets" block.`,
    };
  }
  const isProduction = targetName === "production";
  const value: DerivedTarget = {
    app_name: isProduction ? name : `${name}-${targetName}`,
    target: isProduction ? "production" : targetName,
    // Branch: the target's branch wins, else the manifest webhook branch, else main.
    git_branch: t.branch || manifest.webhook?.branch || "main",
    isProduction,
  };
  // Per-target overrides.
  if (t.replicas !== undefined) value.replicas = t.replicas;
  if (t.domain) value.domain = t.domain;
  if (t.scale_to_zero_after !== undefined) value.scale_to_zero_after = t.scale_to_zero_after;
  if (isProduction) {
    value.placement_pool = "general";
  } else if (t.isolated !== false) {
    // Non-production targets are isolated by default: their own placement
    // pool, and (server-side) their own environment without the prod DB link.
    value.placement_pool = "staging";
  }
  return { ok: true, value };
}

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
  targetName?: string;
  sets: Record<string, string>;
  help: boolean;
} {
  let manifestPath = "";
  let domain: string | undefined;
  let envName: string | undefined;
  let targetName: string | undefined;
  const sets: Record<string, string> = {};
  let help = false;

  for (const arg of args) {
    if (arg.startsWith("--domain=")) {
      domain = arg.slice(9);
    } else if (arg.startsWith("--target=")) {
      targetName = arg.slice(9);
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

  return { manifestPath, domain, envName, targetName, sets, help };
}

export async function deploy(args: string[]): Promise<void> {
  if (args[0] === "stack") {
    const { stackUp } = await import("./stack.ts");
    await stackUp(args.slice(1));
    return;
  }

  const { manifestPath, domain, envName, targetName, sets, help } = parseFlags(args);

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

${BOLD}Options:${RESET}
  --domain=<domain>          Custom domain
  --target=<name>            Deploy a declared target from the manifest's
                             "targets" block (e.g. staging → myapp-staging,
                             its own isolated environment). Mutually exclusive
                             with --env.
  --env=<name|id>            Link an existing environment (env-var bag) by
                             name or id
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

  // Durability policy applies to every path (default/production/target).
  if (manifest.durability_class) body.durability_class = manifest.durability_class;

  // Unified env resolution: manifest defaults + --set, layered on top of a
  // linked environment when one is given. Existing env values win; --set
  // overrides everything.
  let existingKeys = new Set<string>();

  // --target deploys a declared target from the manifest's `targets` block as
  // its own app: a "production" target (and the no-flag default) keeps the bare
  // name; other targets become a `<name>-<t>` sibling wired to an isolated
  // environment server-side. `--env` (below) links an existing env-var bag
  // instead — the two are mutually exclusive.
  if (targetName && envName) {
    console.error(`${RED}--target and --env are mutually exclusive.${RESET}`);
    console.error(`--target deploys a declared target (its own environment); --env links an existing environment.`);
    process.exit(1);
  }

  // No --target: deriveTarget still applies a declared production target (the
  // plain-deploy default); value stays null only without a production target.
  const derived = deriveTarget(manifest, targetName, name);
  if (!derived.ok) {
    console.error(`${RED}${derived.error}${RESET}`);
    console.error(derived.hint);
    process.exit(1);
  }
  const d = derived.value;
  if (d) {
    body.app_name = d.app_name;
    body.target = d.target;
    body.git_branch = d.git_branch;
    if (body.webhook_enabled) body.webhook_branch = d.git_branch;
    if (d.replicas !== undefined) body.replicas = d.replicas;
    if (d.domain) body.domain = d.domain;
    if (d.scale_to_zero_after !== undefined) body.scale_to_zero_after = d.scale_to_zero_after;
    if (d.placement_pool) body.placement_pool = d.placement_pool;

    if (!d.isProduction) {
      // Link to the parent/production app so this is a target of it.
      const apps = await get<Array<{ id: number; name: string }>>("/api/apps");
      const parent = apps.find((a) => a.name === name);
      if (parent) body.target_of = parent.id;
      console.log(
        `${DIM}Target:${RESET}   deploying the ${BOLD}${targetName}${RESET} target of ${BOLD}${name}${RESET} as ${BOLD}${body.app_name}${RESET}`,
      );
    } else if (!targetName) {
      console.log(`${DIM}Target:${RESET}   production (manifest default)`);
    }
  }

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
