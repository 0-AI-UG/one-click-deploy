import { login } from "./commands/login.ts";
import { apps } from "./commands/apps.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { deploy } from "./commands/deploy.ts";
import { restart } from "./commands/restart.ts";
import { rollback } from "./commands/rollback.ts";
import { pause, unpause } from "./commands/pause.ts";
import { services } from "./commands/services.ts";
import { servers } from "./commands/servers.ts";
import { BOLD, DIM, RESET } from "./format.ts";

const VERSION = "0.1.0";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  login,
  apps,
  status,
  logs,
  deploy,
  restart,
  rollback,
  pause,
  unpause,
  services,
  servers,
};

function printUsage(): void {
  console.log(`${BOLD}ocd${RESET} — One-Click Deploy CLI v${VERSION}

${BOLD}Usage:${RESET} ocd <command> [args]

${BOLD}Commands:${RESET}
  login <panel-url>    Log in to a panel
  status               Dashboard overview
  apps                 List all apps
  logs <app> [--tail=N] View app logs
  deploy <app>         Redeploy an app
  restart <app>        Restart an app
  rollback <app>       Roll back to previous deployment
  pause <app>          Pause an app
  unpause <app>        Unpause an app
  services             List services
  servers              List servers

${DIM}App arguments accept name or numeric ID.${RESET}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`ocd v${VERSION}`);
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
