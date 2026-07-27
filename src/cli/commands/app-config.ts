import { deploy } from "./deploy.ts";
import { BOLD, RESET } from "../format.ts";

export async function appConfig(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "diff") {
    await deploy([...args.slice(1), "--dry-run"]);
    return;
  }
  if (sub === "apply") {
    await deploy([...args.slice(1), "--config-only"]);
    return;
  }
  console.error(`${BOLD}Usage:${RESET} ocd config diff [manifest]
       ocd config apply [manifest]

Diff or apply the manifest as OCD's desired app configuration. Neither command
deploys code; use \`ocd deploy\` to apply configuration and deploy together.`);
}
