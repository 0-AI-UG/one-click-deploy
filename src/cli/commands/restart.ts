import { post, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { GREEN, RED, RESET } from "../format.ts";

export async function restart(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd restart <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const { op_id } = await post<{ op_id: number }>(`/api/apps/${app.id}/restart`);
  const result = await followOp(op_id);

  if (result.ok) {
    console.log(`${GREEN}Restarted ${app.name}${RESET}`);
  } else {
    console.error(`${RED}Restart failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
