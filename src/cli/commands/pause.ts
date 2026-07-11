import { post, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { GREEN, RED, RESET } from "../format.ts";

export async function pause(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd pause <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const { op_id } = await post<{ op_id: number }>(`/api/apps/${app.id}/pause`);
  const result = await followOp(op_id);

  if (result.ok) {
    console.log(`${GREEN}Paused ${app.name}${RESET}`);
  } else {
    console.error(`${RED}Pause failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}

export async function unpause(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd unpause <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const { op_id } = await post<{ op_id: number }>(`/api/apps/${app.id}/unpause`);
  const result = await followOp(op_id);

  if (result.ok) {
    console.log(`${GREEN}Unpaused ${app.name}${RESET}`);
  } else {
    console.error(`${RED}Unpause failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
