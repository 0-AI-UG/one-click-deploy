import { login } from "./commands/login.ts";
import { apps } from "./commands/apps.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { deploy } from "./commands/deploy.ts";
import { release } from "./commands/release.ts";
import { deleteCmd } from "./commands/delete.ts";
import { restart } from "./commands/restart.ts";
import { rollback } from "./commands/rollback.ts";
import { promote } from "./commands/promote.ts";
import { pause, unpause } from "./commands/pause.ts";
import { envs } from "./commands/envs.ts";
import { services } from "./commands/services.ts";
import { stack } from "./commands/stack.ts";
import { ops } from "./commands/ops.ts";
import { servers } from "./commands/servers.ts";
import { ssh } from "./commands/ssh.ts";
import { skill } from "./commands/skill.ts";
import { app } from "./commands/app.ts";
import { scale } from "./commands/scale.ts";
import { resources, volumes } from "./commands/resources.ts";
import { gc } from "./commands/gc.ts";
import { manifest } from "./commands/manifest.ts";
import { BOLD, DIM, RESET } from "./format.ts";
import { VERSION } from "./version.ts";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  login,
  apps,
  status,
  logs,
  deploy,
  release,
  delete: deleteCmd,
  restart,
  rollback,
  promote,
  pause,
  unpause,
  envs,
  services,
  service: services,
  stack,
  ops,
  servers,
  ssh,
  skill,
  app,
  scale,
  resources,
  volumes,
  gc,
  manifest,
};

function printUsage(): void {
  console.log(`${BOLD}ocd${RESET}: One-Click Deploy CLI v${VERSION}

${BOLD}Usage:${RESET} ocd <command> [args]

${BOLD}Commands:${RESET}
  login <panel-url>      Log in to a panel
  status                 Dashboard overview
  apps                   List all apps
  app <command>          Inspect and manage an existing app
  logs <app> [--tail=N]  View app logs
  deploy [manifest]      Apply desired config and its immutable image
  release <app> --image  Publish an externally-built image digest from CI
  deploy stack [manifest]  Deploy a multi-app stack
  manifest validate [path] Validate an app or stack manifest (including children)
  delete <app>           Destroy an app
  delete stack <name>    Destroy a stack and all its members
  envs                   Manage environments and variables
  restart <app>          Restart an app
  rollback <app>         Roll back to previous deployment
  promote                Promote an explicit staging app to production
  pause <app>            Pause an app
  unpause <app>          Unpause an app
  scale <command>        Wake apps, inspect policy, or migrate replicas
  services               List managed services
  service catalog        List available managed-service types and defaults
  service create <name>  Create a standalone managed service
  stack <ls|status|logs>   Inspect multi-app stacks
  ops [--app X]          List deploy engine operations
  ops <id> | logs <id>   Inspect an operation or stream its logs
  ops cancel|retry|finalize <id>  Recover a stuck operation
  servers                Inspect and manage servers
  resources              Inventory and estimated cost
  volumes                Manage attached and retained volumes
  gc [--server X]        Preview safe disk garbage collection (--execute to apply)
  ssh <app> <cmd>        Run a command in an app container
  ssh <app> -i           Interactive shell session
  ssh <server> --server  Interactive shell on a server
  skill install --agent X  Install the OCD skill for an AI coding agent

${DIM}App/server arguments accept name or numeric ID.${RESET}`);
}

/** Best-effort: print the logged-in panel's version alongside the CLI's, so a
 *  stale CLI is easy to spot. Silent if not logged in or the panel is down. */
async function printBackendVersion(): Promise<void> {
  try {
    const { loadConfig } = await import("./config.ts");
    const config = loadConfig();
    if (!config?.panel_url) return;
    const res = await fetch(`${config.panel_url}/api/health`);
    const backend = res.headers.get("X-OCD-Version") || (await res.json().catch(() => null) as { version?: string } | null)?.version;
    if (!backend) return;
    if (VERSION !== "dev" && backend !== VERSION) {
      console.log(`panel v${backend} ${DIM}(CLI is behind — reinstall from your panel)${RESET}`);
    } else {
      console.log(`panel v${backend}`);
    }
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`ocd v${VERSION}`);
    await printBackendVersion();
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Run "ocd help" for usage.`);
    process.exit(1);
  }

  try {
    await handler(process.argv.slice(3));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
