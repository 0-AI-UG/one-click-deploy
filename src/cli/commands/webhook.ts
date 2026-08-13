import { get } from "../api.ts";
import { BOLD, DIM, RESET, table } from "../format.ts";

type PlanResponse = {
  changed_paths: string[];
  comparison_error?: string | null;
  decisions: Array<{
    app: string;
    action: "deploy" | "skip";
    reason: string;
    matching_paths: string[];
  }>;
};

export async function webhook(args: string[]): Promise<void> {
  if (args[0] !== "plan") {
    throw new Error("Usage: ocd webhook plan --stack <name> --base <sha> --head <sha>");
  }
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) values.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (args[i + 1] && !args[i + 1].startsWith("--")) values.set(arg.slice(2), args[++i]);
  }
  const stack = values.get("stack");
  const base = values.get("base");
  const head = values.get("head");
  if (!stack || !base || !head) {
    throw new Error("Usage: ocd webhook plan --stack <name> --base <sha> --head <sha>");
  }
  const query = new URLSearchParams({ stack, base, head });
  const result = await get<PlanResponse>(`/api/webhooks/plan?${query}`);
  console.log(`${BOLD}Changed paths:${RESET} ${result.changed_paths.length}`);
  if (result.comparison_error) console.log(`${DIM}Compare failed; plan is fail-open: ${result.comparison_error}${RESET}`);
  console.log();
  table(["MEMBER", "ACTION", "REASON"], result.decisions.map((decision) => [
    decision.app,
    decision.action,
    decision.reason,
  ]));
  for (const decision of result.decisions) {
    if (decision.matching_paths.length === 0) continue;
    console.log(`\n${decision.app} ${decision.action}`);
    for (const path of decision.matching_paths) console.log(`  ${path}`);
  }
}
