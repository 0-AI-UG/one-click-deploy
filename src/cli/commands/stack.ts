import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { get, post, del } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, colorStatus, table } from "../format.ts";
import { promptLine } from "../prompt.ts";
import { getGitRepo, readManifest, collectEnvVars } from "../manifest.ts";
import { buildStackAppSpec, resolveRepoPath, repoDirOf } from "../../shared/stack-spec.ts";
import type { StackManifest, StackDeployRequest } from "../../shared/rpc.ts";

type AppElement = StackDeployRequest["apps"][number];

interface StackListItem {
  id: number;
  name: string;
  status: string;
  created_at: string;
  app_count: number;
  service_count: number;
}

interface StackDetail {
  id: number;
  name: string;
  status: string;
  created_at: string;
  apps: Array<{ id: number; name: string; status: string; domain: string; public?: number | boolean }>;
  services: Array<{ id: number; name: string; service_type: string; version: string; status: string }>;
}

function readStackManifest(path: string): StackManifest {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as StackManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${RED}Stack manifest not found: ${path}${RESET}`);
    } else {
      console.error(`${RED}Failed to read stack manifest: ${err instanceof Error ? err.message : err}${RESET}`);
    }
    process.exit(1);
  }
}

/**
 * Build a stack app element from its DeployManifest via the shared mapping
 * (src/shared/stack-spec.ts) so the CLI and the web builder deploy identically,
 * then attach the CLI-collected env vars. `manifestDir` is the app manifest's
 * repo-root-relative directory (used to resolve the Dockerfile path).
 */
function buildAppElement(
  key: string,
  entry: StackManifest["apps"][string],
  manifest: ReturnType<typeof readManifest>,
  repo: string,
  envVars: Array<{ key: string; value: string; secret?: boolean }>,
  manifestDir: string,
): AppElement {
  const el = buildStackAppSpec(key, entry, manifest, repo, manifestDir);
  if (envVars.length > 0) el.env_vars = envVars;
  return el;
}

async function resolveStack(name: string): Promise<StackListItem> {
  const list = await get<StackListItem[]>("/api/stacks");

  const id = parseInt(name, 10);
  if (!isNaN(id)) {
    const byId = list.find((s) => s.id === id);
    if (byId) return byId;
  }

  const lower = name.toLowerCase();
  const found = list.find((s) => s.name.toLowerCase() === lower);
  if (found) return found;

  console.error(`Stack not found: ${name}`);
  console.error(`Available: ${list.map((s) => s.name).join(", ") || "(none)"}`);
  process.exit(1);
}

function upUsage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd stack up [manifest] [options]

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
  --set=KEY=VALUE            Set an env var for all apps as a fallback`);
}

async function stackUp(args: string[]): Promise<void> {
  let manifestPath = "";
  const rawSets: string[] = [];
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      upUsage();
      process.exit(0);
    } else if (arg.startsWith("--set=")) {
      rawSets.push(arg.slice(6));
    } else if (!arg.startsWith("--") && !manifestPath) {
      manifestPath = arg;
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
  const services: StackDeployRequest["services"] = [];
  for (const [key, svc] of Object.entries(manifest.services || {})) {
    services.push({
      key,
      type: svc.type,
      version: svc.version,
      volume_size: svc.volume_size,
      env_overrides: svc.env_overrides,
      needs: undefined,
    });
  }

  // Apps
  const apps: AppElement[] = [];
  for (const [key, entry] of Object.entries(manifest.apps)) {
    const appManifest = readManifest(resolve(baseDir, entry.manifest));
    const envVars = await collectEnvVars(appManifest, appSets[key] || {}, {
      fallback: globalSets,
      header: `Required environment variables for ${key}`,
    });
    // Dockerfile paths resolve relative to the app manifest's dir (repo-root-
    // relative, assuming the stack manifest sits at the repo root).
    const manifestDir = repoDirOf(resolveRepoPath("", entry.manifest));
    apps.push(buildAppElement(key, entry, appManifest, repo, envVars, manifestDir));
  }

  const body: StackDeployRequest = { name: manifest.name, services, apps };

  console.log(
    `\nDeploying stack ${BOLD}${manifest.name}${RESET} (${services.length} service(s), ${apps.length} app(s))...`,
  );

  const { op_id } = await post<{ op_id: number }>("/api/stacks", body);
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack deploy complete!${RESET}`);
  } else {
    console.error(`\n${RED}Stack deploy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

async function stackLs(): Promise<void> {
  const list = await get<StackListItem[]>("/api/stacks");
  table(
    ["NAME", "STATUS", "APPS", "SERVICES", "CREATED"],
    list.map((s) => [
      s.name,
      colorStatus(s.status),
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
      colorStatus(a.status),
      a.public === false || a.public === 0 ? `${DIM}(private)${RESET}` : a.domain || "-",
    ]),
  );
}

async function stackLogs(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error(`Usage: ocd stack logs <name>`);
    process.exit(1);
  }
  const stackRef = await resolveStack(name);
  const { log } = await get<{ log: string }>(`/api/stacks/${stackRef.id}/log`);
  process.stdout.write(log || `${DIM}(no log)${RESET}\n`);
}

async function stackDown(args: string[]): Promise<void> {
  let name = "";
  let yes = false;
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (!arg.startsWith("-") && !name) name = arg;
  }
  if (!name) {
    console.error(`Usage: ocd stack down <name> [--yes]`);
    process.exit(1);
  }

  const stackRef = await resolveStack(name);

  if (!yes) {
    const answer = await promptLine(
      `${RED}Destroy stack "${stackRef.name}" and all ${stackRef.app_count} app(s) + ${stackRef.service_count} service(s)?${RESET} [y/N]: `,
    );
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  console.log(`Destroying stack ${BOLD}${stackRef.name}${RESET}...`);
  const { op_id } = await del<{ op_id: number }>(`/api/stacks/${stackRef.id}`);
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}Stack destroyed.${RESET}`);
  } else {
    console.error(`\n${RED}Stack destroy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd stack <up|down|ls|status|logs> [args]

${BOLD}Subcommands:${RESET}
  up [manifest]        Deploy a stack (default manifest: ocd-stack.json)
  ls                   List all stacks
  status <name>        Show a stack's apps and services
  logs <name>          Print a stack's deploy log
  down <name> [--yes]  Destroy a stack and all its members`);
}

export async function stack(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "up":
      await stackUp(rest);
      break;
    case "ls":
      await stackLs();
      break;
    case "status":
      await stackStatus(rest);
      break;
    case "logs":
      await stackLogs(rest);
      break;
    case "down":
      await stackDown(rest);
      break;
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
