import { del, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { webConfirm } from "../confirm.ts";
import { stackDown } from "./stack.ts";
import { BOLD, GREEN, RED, RESET } from "../format.ts";

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd delete <app>
       ocd delete stack <name> [--suspend-webhooks]

Destroys an app (its container(s), DNS records, and managed volumes) or a
whole stack. Stack deletion always suspends and supersedes member webhook
deployments; --suspend-webhooks explicitly requests this safe default.
Stack deletion always requires confirmation in the OCD web UI.
App and stack deletion always require confirmation in the OCD web UI.`);
}

export async function deleteCmd(args: string[]): Promise<void> {
  if (args.includes("--yes") || args.includes("-y")) {
    throw new Error("--yes has been removed; approve deletion in the web UI");
  }
  const sub = args[0];

  if (sub === "stack") {
    await stackDown(args.slice(1));
    return;
  }

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    usage();
    return;
  }

  let name = "";
  for (const arg of args) {
    if (!arg.startsWith("-") && !name) name = arg;
  }

  const app = await resolveApp(name);
  const confirm = await webConfirm("delete_app", "app", app.id);
  if (!confirm) {
    console.log("Aborted.");
    return;
  }

  console.log(`Destroying app ${BOLD}${app.name}${RESET}...`);
  const { op_id } = await del<{ op_id: number }>(`/api/apps/${app.id}`, undefined, {
    "X-OCD-Confirmation": confirm,
  });
  const result = await followOp(op_id);
  if (result.ok) {
    console.log(`\n${GREEN}App destroyed.${RESET}`);
  } else {
    console.error(`\n${RED}App destroy failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
