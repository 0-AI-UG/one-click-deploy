import { resolve } from "node:path";
import { get, post, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../format.ts";
import { getGitRepo, readManifest } from "../manifest.ts";
import { promptLine } from "../prompt.ts";
import type { PromoteRequest } from "../../shared/rpc.ts";

interface Deployment {
  id: number;
  status: string;
  git_commit: string;
}

function parseFlags(args: string[]): { from?: string; to?: string; yes: boolean; help: boolean } {
  let from: string | undefined;
  let to: string | undefined;
  let yes = false;
  let help = false;
  for (const arg of args) {
    if (arg.startsWith("--from=")) from = arg.slice(7);
    else if (arg.startsWith("--to=")) to = arg.slice(5);
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--help" || arg === "-h") help = true;
  }
  return { from, to, yes, help };
}

interface StackListItem {
  id: number;
  name: string;
  app_count: number;
  staging_sibling_count?: number;
}

/** Resolve a stack by id or (case-insensitive) name, mirroring `ocd stack`. */
async function resolveStack(nameOrId: string): Promise<StackListItem> {
  const list = await get<StackListItem[]>("/api/stacks");
  // Only an ALL-digit argument is an id. `parseInt("3rd-party")` is 3, which
  // would otherwise promote stack #3 — a production swap on the wrong stack.
  // Stack names may start with a digit (NAME_RE allows [a-z0-9][a-z0-9-]*).
  const id = /^\d+$/.test(nameOrId) ? parseInt(nameOrId, 10) : NaN;
  const found =
    (!isNaN(id) ? list.find((s) => s.id === id) : undefined) ??
    list.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
  if (found) return found;
  console.error(`${RED}Stack not found: ${nameOrId}${RESET}`);
  console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

/**
 * `ocd promote stack <name>` — promote every member of a stack that has a
 * webhook-staging sibling with a deployed commit. Member selection lives
 * server-side in the promote_stack op; this only resolves + follows.
 */
async function promoteStack(args: string[]): Promise<void> {
  const { yes, help } = parseFlags(args);
  const name = args.find((a) => !a.startsWith("-"));

  if (help || !name) {
    console.error(`${BOLD}Usage:${RESET} ocd promote stack <name|id> [--yes]

Promotes every member of the stack that has a webhook-staging sibling holding a
successful deployment. Members without a sibling (or whose sibling has never
deployed) are skipped and reported in the stack log.

Members are promoted dependency level by dependency level. Independent members
within one level may promote concurrently.

${BOLD}Options:${RESET}
  --yes, -y         Skip the confirmation prompt`);
    process.exit(help ? 0 : 1);
  }

  const stack = await resolveStack(name!);
  const pending = stack.staging_sibling_count ?? 0;
  if (pending === 0) {
    console.error(`${RED}Stack ${stack.name} has no members with a staging sibling to promote.${RESET}`);
    process.exit(1);
  }

  console.log(
    `Promote staging for ${BOLD}${stack.name}${RESET} ${DIM}(${pending} member(s) with a staging sibling)${RESET}`,
  );

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`${RED}Refusing to promote without confirmation (non-interactive). Pass --yes.${RESET}`);
      process.exit(1);
    }
    const answer = (await promptLine(`Continue? [y/N] `)).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  const { op_id } = await post<{ op_id: number }>(`/api/stacks/${stack.id}/promote`, {});
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Promoted staging for stack ${stack.name}${RESET}`);
  } else {
    console.error(`\n${RED}Promote failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

export async function promote(args: string[]): Promise<void> {
  if (args[0] === "stack") return promoteStack(args.slice(1));

  const { from, to, yes, help } = parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd promote [--yes]
       ocd promote --from=<app> --to=<app> [--yes]
       ocd promote stack <name|id> [--yes]

Promotes the exact version running in a source (e.g. staging) app up to a
destination (production) app by rebuilding it from the source's git commit.

Run with no arguments inside a repo to promote its webhook-staging sibling:
source = <name>-staging, destination = <name>, where <name> comes from the
manifest. Use --from/--to to promote between any two apps explicitly.

Use \`ocd promote stack <name>\` to promote ready staging siblings in one stack
operation, respecting dependency levels.

${BOLD}Options:${RESET}
  --from=<app>      Explicit source app (name or id)
  --to=<app>        Explicit destination app (name or id)
  --yes, -y         Skip the confirmation prompt`);
    process.exit(0);
  }

  // Resolve source/destination names: explicit --from/--to wins; otherwise
  // promote the webhook-staging sibling derived from the manifest.
  let sourceName: string;
  let destName: string;
  if (from || to) {
    if (!from || !to) {
      console.error(`${RED}Both --from and --to are required together.${RESET}`);
      process.exit(1);
    }
    sourceName = from;
    destName = to;
  } else {
    const repo = getGitRepo();
    const manifest = readManifest(resolve(".ocd-deploy.json"));
    const name = manifest.suggested_app_name || repo.replace(/.*\//, "");
    sourceName = `${name}-staging`;
    destName = name;
  }

  const source = await resolveApp(sourceName);
  const dest = await resolveApp(destName);

  if (source.id === dest.id) {
    console.error(`${RED}Source and destination must be different apps.${RESET}`);
    process.exit(1);
  }

  // Show the commit that will be promoted (source's latest successful deploy).
  const deployments = await get<Deployment[]>(`/api/apps/${source.id}/deployments`);
  const current = deployments.find((d) => d.status === "deployed");
  if (!current) {
    console.error(`${RED}${source.name} has no successful deployment to promote.${RESET}`);
    process.exit(1);
  }

  console.log(
    `Promote ${BOLD}${source.name}${RESET} ${DIM}(commit ${current.git_commit})${RESET} → ${BOLD}${dest.name}${RESET}`,
  );
  if (source.git_repo !== dest.git_repo) {
    console.log(`${YELLOW}Warning: source and destination have different git repos.${RESET}`);
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error(`${RED}Refusing to promote without confirmation (non-interactive). Pass --yes.${RESET}`);
      process.exit(1);
    }
    const answer = (await promptLine(`Continue? [y/N] `)).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  const body: PromoteRequest = { source_app: source.name, dest_app: dest.name };
  const { op_id } = await post<{ op_id: number }>("/api/apps/promote", body);

  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Promoted ${source.name} → ${dest.name}${RESET}`);
  } else {
    console.error(`\n${RED}Promote failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
