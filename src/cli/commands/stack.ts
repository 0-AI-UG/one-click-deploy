import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { get, post, del } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";
import { webConfirm } from "../confirm.ts";
import { getGitRepo, readManifest, promptRequired, resolveAuthPassword, manifestHash } from "../manifest.ts";
import { mergeEnv, type AppEnvDefs } from "../../shared/env-merge.ts";
import { buildStackAppSpec, resolveRepoPath, repoDirOf } from "../../shared/stack-spec.ts";
import { validateStackManifest } from "../../shared/manifest-validate.ts";
import type { StackManifest, StackDeployRequest } from "../../shared/rpc.ts";

type AppElement = StackDeployRequest["apps"][number];

/** Pure manifest→wire mapping kept exported for parity regression tests. */
export function buildStackServiceSpecs(
  manifest: StackManifest,
): StackDeployRequest["services"] {
  return Object.entries(manifest.services || {}).map(([key, svc]) => ({
    key,
    type: svc.type,
    version: svc.version,
    volume_size: svc.volume_size,
    env_overrides: svc.env_overrides,
    domain: svc.domain,
    needs: undefined,
  }));
}

interface StackListItem {
  id: number;
  name: string;
  status: string;
  created_at: string;
  app_count: number;
  service_count: number;
  environment_id?: number | null;
  /** The stack's shared webhook-staging environment, remembered across re-ups. */
  staging_environment_id?: number | null;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
}

interface StackDetail {
  id: number;
  name: string;
  status: string;
  created_at: string;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
  resource_status_reason?: string;
  apps: Array<{ id: number; name: string; status: string; domain: string; public?: number | boolean; environment_stale?: number | boolean }>;
  services: Array<{ id: number; name: string; service_type: string; version: string; status: string }>;
}

function readStackManifest(path: string): StackManifest {
  let manifest: StackManifest;
  try {
    const raw = readFileSync(path, "utf-8");
    manifest = JSON.parse(raw) as StackManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${RED}Stack manifest not found: ${path}${RESET}`);
    } else {
      console.error(`${RED}Failed to read stack manifest: ${err instanceof Error ? err.message : err}${RESET}`);
    }
    process.exit(1);
  }
  try {
    validateStackManifest(manifest, path);
  } catch (err) {
    console.error(`${RED}${err instanceof Error ? err.message : err}${RESET}`);
    process.exit(1);
  }
  return manifest;
}

/**
 * Build a stack app element from its DeployManifest via the shared mapping
 * (src/shared/stack-spec.ts), then attach the CLI-collected env vars.
 * `manifestDir` is the app manifest's repo-root-relative directory (used to
 * resolve the Dockerfile path).
 */
function buildAppElement(
  key: string,
  entry: StackManifest["apps"][string],
  manifest: ReturnType<typeof readManifest>,
  repo: string,
  envVars: Array<{ key: string; value: string; secret?: boolean }>,
  manifestDir: string,
  manifestPath: string,
  manifestFullPath: string,
): AppElement {
  const el = buildStackAppSpec(key, entry, manifest, repo, manifestDir);
  el.manifest_path = manifestPath;
  el.manifest_hash = manifestHash(manifestFullPath);
  if (envVars.length > 0) el.env_vars = envVars;
  return el;
}

/** Non-exiting lookup — returns undefined instead of exiting when no stack row
 *  matches, so callers (e.g. stack logs) can fall back to op history. */
async function lookupStack(name: string): Promise<StackListItem | undefined> {
  const list = await get<StackListItem[]>("/api/stacks");

  // All-digit only: `parseInt("3rd-party")` is 3, which would resolve a
  // digit-leading stack name to an unrelated stack id — and `ocd delete stack`
  // destroys whatever this returns. Names may start with a digit.
  if (/^\d+$/.test(name)) {
    const id = parseInt(name, 10);
    const byId = list.find((s) => s.id === id);
    if (byId) return byId;
  }

  const lower = name.toLowerCase();
  return list.find((s) => s.name.toLowerCase() === lower);
}

async function resolveStack(name: string): Promise<StackListItem> {
  const found = await lookupStack(name);
  if (found) return found;

  const list = await get<StackListItem[]>("/api/stacks");
  console.error(`Stack not found: ${name}`);
  console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function upUsage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd deploy stack [manifest] [options]

Deploys a multi-app stack from an ocd-stack.json manifest. Each app entry
references a .ocd-deploy.json (resolved relative to the stack manifest). All
apps deploy from the current git repo's "origin" remote.

Env vars are collected per app from each app's manifest env[] section:
defaults are sent as-is, --set overrides or adds values, and required vars
without a value are prompted for (grouped per app).

${BOLD}Arguments:${RESET}
  [manifest]                 Path to stack manifest (default: ocd-stack.json)

${BOLD}Options:${RESET}
  --set=<app>.KEY=VALUE      Set an env var for one app (repeatable)
  --set=KEY=VALUE            Set an env var for all apps as a fallback
  --env=<name|id>            Reuse an existing environment when first creating
                             the stack (auto-created otherwise). On re-ups the
                             stack's linked environment is remembered, so --env
                             is not needed to resume.
  --staging-env=<name|id>    The stack's webhook-staging environment — one per
                             stack, like --env. Every member whose own manifest
                             sets "webhook": { "enabled": true, "staging": true }
                             deploys its <name>-staging sibling with it.
                             Optional: when a member opts in and the stack has
                             no staging environment yet, one is auto-created as
                             a copy of the stack's environment. Remembered
                             across re-ups; --staging-env= (empty) clears it.`);
}

/**
 * Parse repeatable `--staging-env=` values into the stack's single staging
 * environment selection. Pure (no I/O, no exits) so it can be unit-tested; the
 * caller resolves the ref and reports `error` itself.
 *
 * Returns undefined when the flag is absent (the stack keeps its stored value),
 * null when explicitly cleared (`--staging-env=`), otherwise an environment
 * name or id to resolve.
 */
export function parseStagingEnvFlags(
  values: string[],
): { ok: true; stagingEnv: string | null | undefined } | { ok: false; error: string } {
  const show = (v: string | null) => (v === null ? "(cleared)" : `"${v}"`);
  let stagingEnv: string | null | undefined;

  for (const raw of values) {
    const ref = raw.trim() === "" ? null : raw.trim();
    if (stagingEnv !== undefined && stagingEnv !== ref) {
      return {
        ok: false,
        error:
          `--staging-env was given more than once with different values (${show(stagingEnv)} and ${show(ref)}) — ` +
          `a stack has one staging environment.`,
      };
    }
    stagingEnv = ref;
  }

  return { ok: true, stagingEnv };
}

type ResolvedEnv = { id: number; name: string; env_vars?: Array<{ key: string }> };

async function resolveEnvironment(nameOrId: string): Promise<ResolvedEnv> {
  const list = await get<ResolvedEnv[]>("/api/environments");
  // All-digit only: `parseInt("3rd-party")` is 3, which would resolve an
  // environment named with a leading digit to an unrelated environment id.
  const byId = /^\d+$/.test(nameOrId) ? list.find((e) => e.id === parseInt(nameOrId, 10)) : undefined;
  if (byId) return byId;
  const lower = nameOrId.toLowerCase();
  const byName = list.find((e) => e.name.toLowerCase() === lower);
  if (byName) return byName;
  console.error(`${RED}Environment not found: ${nameOrId}${RESET}`);
  console.error(`Available: ${list.map((e) => e.name).join(", ") || "(none)"}`);
  process.exit(1);
}

/** The already-created stack row for this manifest (the server remembers its
 *  linked environment and staging environment across re-ups), or undefined when
 *  the stack doesn't exist yet. */
async function findStackByName(name: string): Promise<StackListItem | undefined> {
  const list = await get<StackListItem[]>("/api/stacks");
  const lower = name.toLowerCase();
  return list.find((s) => s.name.toLowerCase() === lower);
}

async function findEnvironmentById(id: number): Promise<ResolvedEnv | undefined> {
  const list = await get<ResolvedEnv[]>("/api/environments");
  return list.find((e) => e.id === id);
}

export async function stackUp(args: string[]): Promise<void> {
  let manifestPath = "";
  let envRef = "";
  const rawSets: string[] = [];
  const rawStagingEnvs: string[] = [];
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      upUsage();
      process.exit(0);
    } else if (arg.startsWith("--set=")) {
      rawSets.push(arg.slice(6));
    } else if (arg.startsWith("--staging-env=")) {
      rawStagingEnvs.push(arg.slice(14));
    } else if (arg.startsWith("--env=")) {
      envRef = arg.slice(6);
    } else if (arg.startsWith("--")) {
      console.error(`${RED}Unknown option: ${arg}${RESET}`);
      process.exit(1);
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
    } else {
      console.error(`${RED}Unexpected argument: ${arg}${RESET}`);
      process.exit(1);
    }
  }
  if (!manifestPath) manifestPath = "ocd-stack.json";

  const manifestFullPath = resolve(manifestPath);
  const manifest = readStackManifest(manifestFullPath);
  const baseDir = dirname(manifestFullPath);

  if (!manifest.name) {
    console.error(`${RED}Stack manifest is missing a "name"${RESET}`);
    process.exit(1);
  }
  if (!manifest.apps || Object.keys(manifest.apps).length === 0) {
    console.error(`${RED}Stack manifest has no apps${RESET}`);
    process.exit(1);
  }

  const appKeys = new Set(Object.keys(manifest.apps));

  const stagingParsed = parseStagingEnvFlags(rawStagingEnvs);
  if (!stagingParsed.ok) {
    console.error(`${RED}${stagingParsed.error}${RESET}`);
    process.exit(1);
  }
  const stagingEnvRef = stagingParsed.stagingEnv;

  // Parse --set into per-app (<app>.KEY) and global (KEY) buckets. A plain
  // KEY is a fallback applied to any app that declares it; an <app>.KEY targets
  // that one app.
  const globalSets: Record<string, string> = {};
  const appSets: Record<string, Record<string, string>> = {};
  for (const pair of rawSets) {
    const eq = pair.indexOf("=");
    if (eq < 1) {
      console.error(`${RED}Invalid --set value (expected --set=KEY=VALUE or --set=app.KEY=VALUE): ${pair}${RESET}`);
      process.exit(1);
    }
    const lhs = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const dot = lhs.indexOf(".");
    if (dot > 0 && appKeys.has(lhs.slice(0, dot))) {
      const ak = lhs.slice(0, dot);
      const key = lhs.slice(dot + 1);
      (appSets[ak] ||= {})[key] = value;
    } else {
      globalSets[lhs] = value;
    }
  }

  const repo = getGitRepo();

  console.log(`${DIM}Repo:${RESET}  ${repo}`);
  console.log(`${DIM}Stack:${RESET} ${manifestPath} ${BOLD}(${manifest.name})${RESET}`);

  // Managed services
  const services = buildStackServiceSpecs(manifest);

  // Apps. Members share one environment, so env vars are merged across all
  // apps (not collected per-app) into a single stack env.
  const apps: AppElement[] = [];
  const appEnvDefs: AppEnvDefs[] = [];
  for (const [key, entry] of Object.entries(manifest.apps)) {
    const appManifest = readManifest(resolve(baseDir, entry.manifest));
    appEnvDefs.push({ app: key, defs: appManifest.env || [] });
    // Dockerfile paths resolve relative to the app manifest's dir (repo-root-
    // relative, assuming the stack manifest sits at the repo root).
    const manifestDir = repoDirOf(resolveRepoPath("", entry.manifest));
    const childManifestPath = resolve(baseDir, entry.manifest);
    const appElement = buildAppElement(
      key,
      entry,
      appManifest,
      repo,
      [],
      manifestDir,
      resolveRepoPath("", entry.manifest),
      childManifestPath,
    );
    const authPassword = await resolveAuthPassword(appManifest.auth);
    if (authPassword !== undefined) appElement.auth_password = authPassword;
    apps.push(appElement);
  }

  // Resolve the target environment (reused or, if omitted, auto-created) so we
  // know which keys already exist — existing values win over manifest defaults.
  const existingStack = await findStackByName(manifest.name);
  let reused = envRef ? await resolveEnvironment(envRef) : undefined;
  let resumed = false;
  // Resume: an already-created stack stays linked to its environment
  // server-side, so even without --env we seed existing keys from that env —
  // otherwise a re-up re-prompts for (and re-requires) vars already stored.
  if (!reused && existingStack?.environment_id != null) {
    reused = await findEnvironmentById(existingStack.environment_id);
    resumed = !!reused;
  }
  const existingKeys = new Set((reused?.env_vars || []).map((v) => v.key));

  // --- webhook staging -----------------------------------------------------
  // Members declare the intent (webhook.staging in their own manifest, carried
  // here as `webhook_staging`); the environment is one per stack, exactly like
  // the production --env. --staging-env is optional: when a member opts in and
  // the stack has no staging env yet, the deploy op auto-creates
  // <stack>-stack-staging-env as a copy of the stack's environment.
  //
  // Leave undefined when the flag is absent — the deploy op then preserves the
  // stack's stored staging env. Only an explicit `--staging-env=` sends null.
  let stagingEnvId: number | null | undefined;
  let stagingEnvName: string | undefined;
  if (stagingEnvRef === null) {
    stagingEnvId = null;
  } else if (stagingEnvRef !== undefined) {
    const env = await resolveEnvironment(stagingEnvRef);
    stagingEnvId = env.id;
    stagingEnvName = env.name;
  }

  // --set overrides target the shared env; app-scoped (`app.KEY`) and global
  // (`KEY`) both resolve to one key here, app-scoped last so it wins.
  const overrides: Record<string, string> = { ...globalSets };
  for (const perApp of Object.values(appSets)) Object.assign(overrides, perApp);

  const merged = mergeEnv(appEnvDefs, overrides, existingKeys);
  if (merged.conflicts.length > 0) {
    console.error(`\n${RED}Env var conflicts — apps disagree on a default and nothing resolves it:${RESET}`);
    for (const c of merged.conflicts) {
      console.error(`  ${BOLD}${c.key}${RESET}: ${c.apps.join(", ")} disagree — values: ${c.values.join(" | ")}`);
    }
    console.error(`Resolve with --set=${merged.conflicts[0].key}=VALUE or an existing environment.`);
    process.exit(1);
  }
  const prompted = await promptRequired(merged.requiredMissing, "Required environment variables (stack)");
  const env_vars = [...merged.entries, ...prompted];

  const body: StackDeployRequest = {
    name: manifest.name,
    environment_id: reused?.id,
    staging_environment_id: stagingEnvId,
    env_vars: env_vars.length > 0 ? env_vars : undefined,
    services,
    apps,
  };

  console.log(
    `\nDeploying stack ${BOLD}${manifest.name}${RESET} (${services.length} service(s), ${apps.length} app(s))...`,
  );
  if (reused) {
    console.log(
      `${DIM}Env:${RESET}   reusing ${resumed ? "linked" : ""} environment ${reused.name}`.replace("  ", " "),
    );
  }
  if (stagingEnvName) console.log(`${DIM}Staging:${RESET} ${stagingEnvName}`);
  else if (stagingEnvId === null) console.log(`${DIM}Staging:${RESET} (cleared)`);

  const { op_id, attached } = await post<{ op_id: number; attached?: boolean }>("/api/stacks", body);
  if (attached) {
    console.log(
      `\n${DIM}A deploy of ${manifest.name} is already in progress — attaching to op #${op_id}…${RESET}`,
    );
  }
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack deploy complete!${RESET}`);
  } else {
    console.error(`\n${RED}Stack deploy failed: ${result.error || "unknown error"}${RESET}`);
    console.error(
      `${DIM}Check progress with:${RESET} ocd stack logs ${manifest.name}   ${DIM}·${RESET}   ocd stack ls`,
    );
    process.exit(1);
  }
}

async function stackLs(): Promise<void> {
  const list = await get<StackListItem[]>("/api/stacks");
  table(
    ["NAME", "STATUS", "LAST OP", "APPS", "SERVICES", "CREATED"],
    list.map((s) => [
      s.name,
      colorStatus(s.status),
      s.last_operation_id
        ? `#${s.last_operation_id} ${s.last_operation_status}${s.last_operation_failed ? " (failed)" : ""}`
        : "-",
      String(s.app_count),
      String(s.service_count),
      (s.created_at || "").replace("T", " ").slice(0, 16),
    ]),
  );
}

async function stackStatus(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ocd stack status <name>`);
    process.exit(1);
  }
  const stackRef = await resolveStack(name);
  const detail = await get<StackDetail>(`/api/stacks/${stackRef.id}`);

  console.log(`${BOLD}${detail.name}${RESET}  ${colorStatus(detail.status)}`);
  if (detail.resource_status_reason) {
    console.log(`${DIM}Resources:${RESET} ${detail.resource_status_reason}`);
  }
  console.log(
    `${DIM}Last operation:${RESET} ` +
      (detail.last_operation_id
        ? `#${detail.last_operation_id} ${detail.last_operation_status}` +
          `${detail.last_operation_failed ? " (failed)" : ""}` +
          `${detail.operation_in_progress ? " (in progress)" : ""}`
        : "none"),
  );
  console.log(`${DIM}Created:${RESET} ${(detail.created_at || "").replace("T", " ").slice(0, 16)}\n`);

  console.log(`${BOLD}Services${RESET}`);
  table(
    ["NAME", "TYPE", "VERSION", "STATUS"],
    (detail.services || []).map((s) => [s.name, s.service_type, s.version || "-", colorStatus(s.status)]),
  );

  console.log(`\n${BOLD}Apps${RESET}`);
  table(
    ["NAME", "STATUS", "ADDRESS"],
    (detail.apps || []).map((a) => [
      a.name,
      a.environment_stale
        ? `${colorStatus(a.status)} — stale environment, redeploy required`
        : colorStatus(a.status),
      a.public === false || a.public === 0 ? `${DIM}(private)${RESET}` : a.domain || "-",
    ]),
  );
}

interface OpRow {
  id: number;
  kind: string;
  resource_keys: string[];
  enqueued_at: string | null;
}

/** A failed stack deploy compensates and deletes its stacks row — exactly when
 *  the logs matter most. When no stack row exists, find the most recent
 *  deploy_stack op targeting `stack:<name>` so its logs are still reachable. */
async function findStackDeployOp(name: string): Promise<OpRow | undefined> {
  const data = await get<{ running: OpRow[]; pending: OpRow[]; recent: OpRow[] }>("/api/operations");
  const key = `stack:${name.toLowerCase()}`;
  const all = [...(data.running || []), ...(data.pending || []), ...(data.recent || [])];
  return all.find(
    (op) => op.kind === "deploy_stack" && (op.resource_keys || []).some((k) => k.toLowerCase() === key),
  );
}

async function stackLogs(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ocd stack logs <name>`);
    process.exit(1);
  }

  const stackRef = await lookupStack(name);
  if (stackRef) {
    const { log } = await get<{ log: string }>(`/api/stacks/${stackRef.id}/log`);
    process.stdout.write(log || `${DIM}(no log)${RESET}\n`);
    return;
  }

  // Stack row is gone (likely a failed deploy that rolled back) — surface the
  // deploy operation's logs instead.
  const op = await findStackDeployOp(name);
  if (!op) {
    console.error(`Stack not found: ${name}`);
    const list = await get<StackListItem[]>("/api/stacks");
    console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
    process.exit(1);
  }

  console.error(
    `${DIM}Stack "${name}" no longer exists (deploy failed and rolled back). Showing operation #${op.id} logs:${RESET}`,
  );
  const { logs } = await get<{ logs: Array<{ ts: string; level: string; message: string }> }>(
    `/api/operations/${op.id}/logs?since=0`,
  );
  for (const l of logs) {
    const ts = (l.ts || "").replace("T", " ").slice(0, 19);
    console.log(`${DIM}${ts}${RESET} ${l.level} ${l.message}`);
  }
}

async function stackMemberLogs(args: string[]): Promise<void> {
  const name = args.find((arg) => !arg.startsWith("-"));
  if (!name) {
    console.error(`Usage: ocd stack member-logs <name|id> [--tail=N]`);
    process.exit(1);
  }
  const tailArg = args.find((arg) => arg.startsWith("--tail="));
  const tail = tailArg ? parseInt(tailArg.slice(7), 10) : 100;
  if (!Number.isInteger(tail) || tail < 1 || tail > 1000) {
    console.error(`${RED}--tail must be an integer from 1 to 1000${RESET}`);
    process.exit(1);
  }
  const stackRef = await resolveStack(name);
  const { members } = await get<{
    members: Array<{ kind: "app" | "service"; id: number; name: string; logs: string; error?: string }>;
  }>(`/api/stacks/${stackRef.id}/member-logs?tail=${tail}`);
  for (const member of members) {
    console.log(`${BOLD}==> ${member.kind} ${member.name} (#${member.id}) <==${RESET}`);
    if (member.error) console.log(`${RED}${member.error}${RESET}`);
    else process.stdout.write(member.logs.endsWith("\n") ? member.logs : `${member.logs}\n`);
  }
  if (members.length === 0) console.log(`${DIM}(no readable member logs)${RESET}`);
}

async function stackRedeploy(args: string[]): Promise<void> {
  const name = args.find((arg) => !arg.startsWith("-"));
  if (!name) {
    console.error(`Usage: ocd stack redeploy <name|id>`);
    process.exit(1);
  }
  const stackRef = await resolveStack(name);
  console.log(`Redeploying stack ${BOLD}${stackRef.name}${RESET} from stored configuration...`);
  const { op_id } = await post<{ op_id: number }>(`/api/stacks/${stackRef.id}/redeploy`, {});
  const result = await followOp(op_id);
  if (!result.ok) {
    console.error(`\n${RED}Stack redeploy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}Stack redeployed.${RESET}`);
}

export async function stackDown(args: string[]): Promise<void> {
  let name = "";
  for (const arg of args) {
    if (!arg.startsWith("-") && !name) name = arg;
  }
  if (!name) {
    console.error(`Usage: ocd delete stack <name> [--suspend-webhooks]`);
    process.exit(1);
  }
  const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--suspend-webhooks");
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}`);
    process.exit(1);
  }

  const stackRef = await resolveStack(name);

  const confirm = await webConfirm("delete_stack", "stack", stackRef.id);
  if (!confirm) {
    console.log("Aborted.");
    return;
  }

  console.log(`Destroying stack ${BOLD}${stackRef.name}${RESET}...`);
  console.log(`${DIM}Member webhook deployments will be suspended and superseded (default).${RESET}`);
  const { op_id, suspended_webhook_operation_ids } = await del<{
    op_id: number;
    suspended_webhook_operation_ids?: number[];
  }>(`/api/stacks/${stackRef.id}`, undefined, {
    "X-OCD-Confirmation": confirm,
  });
  if (suspended_webhook_operation_ids?.length) {
    console.log(
      `${DIM}Suspended webhook operation(s): ` +
        `${suspended_webhook_operation_ids.map((id) => `#${id}`).join(", ")}${RESET}`,
    );
  }
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack destroyed.${RESET}`);
  } else {
    console.error(`\n${RED}Stack destroy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd stack <ls|status|logs|member-logs|redeploy> [args]

${BOLD}Subcommands:${RESET}
  ls                   List all stacks
  status <name>        Show a stack's apps and services
  logs <name>          Print a stack's deploy log
  member-logs <name>   Print current container logs for every readable member
  redeploy <name>      Redeploy every member from stored configuration

${DIM}Deploy a stack with \`ocd deploy stack\`; destroy one with \`ocd delete stack\`.${RESET}`);
}

export async function stack(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "up":
      console.error("`ocd stack up` has moved to `ocd deploy stack`.");
      process.exit(1);
    case "ls":
      await stackLs();
      break;
    case "status":
      await stackStatus(rest);
      break;
    case "logs":
      await stackLogs(rest);
      break;
    case "member-logs":
    case "members-logs":
      await stackMemberLogs(rest);
      break;
    case "redeploy":
      await stackRedeploy(rest);
      break;
    case "down":
      console.error("`ocd stack down` has moved to `ocd delete stack`.");
      process.exit(1);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown stack subcommand: ${sub}`);
      usage();
      process.exit(1);
  }
}
