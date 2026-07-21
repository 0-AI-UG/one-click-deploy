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

export async function promote(args: string[]): Promise<void> {
  const { from, to, yes, help } = parseFlags(args);

  if (help) {
    console.error(`${BOLD}Usage:${RESET} ocd promote [--yes]
       ocd promote --from=<app> --to=<app> [--yes]

Promotes the exact version running in a source (e.g. staging) app up to a
destination (production) app by rebuilding it from the source's git commit.

Run with no arguments inside a repo to promote its webhook-staging sibling:
source = <name>-staging, destination = <name>, where <name> comes from the
manifest. Use --from/--to to promote between any two apps explicitly.

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
