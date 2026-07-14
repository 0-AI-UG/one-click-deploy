import { login } from "./commands/login.ts";
import { apps } from "./commands/apps.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { deploy } from "./commands/deploy.ts";
import { redeploy } from "./commands/redeploy.ts";
import { restart } from "./commands/restart.ts";
import { rollback } from "./commands/rollback.ts";
import { pause, unpause } from "./commands/pause.ts";
import { envs } from "./commands/envs.ts";
import { services } from "./commands/services.ts";
import { stack } from "./commands/stack.ts";
import { ops } from "./commands/ops.ts";
import { servers } from "./commands/servers.ts";
import { ssh } from "./commands/ssh.ts";
import { BOLD, DIM, RESET } from "./format.ts";
import { VERSION } from "./version.ts";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  login,
  apps,
  status,
  logs,
  deploy,
  redeploy,
  restart,
  rollback,
  pause,
  unpause,
  envs,
  services,
  stack,
  ops,
  servers,
  ssh,
};

function printUsage(): void {
  console.log(`${BOLD}ocd${RESET}: One-Click Deploy CLI v${VERSION}

${BOLD}Usage:${RESET} ocd <command> [args]

${BOLD}Commands:${RESET}
  login <panel-url>      Log in to a panel
  status                 Dashboard overview
  apps                   List all apps
  logs <app> [--tail=N]  View app logs
  deploy [manifest]       Deploy current repo using .ocd-deploy.json
  redeploy <app>         Redeploy an existing app
  envs                   Manage environments and variables
  restart <app>          Restart an app
  rollback <app>         Roll back to previous deployment
  pause <app>            Pause an app
  unpause <app>          Unpause an app
  services               List services
  stack <up|down|ls|status|logs>   Manage multi-app stacks
  ops [--app X]          List deploy engine operations
  ops <id> | logs <id>   Inspect an operation or stream its logs
  servers                List servers
  ssh <app> <cmd>        Run a command in an app container
  ssh <app> -i           Interactive shell session
  ssh <server> --server  Interactive shell on a server

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
