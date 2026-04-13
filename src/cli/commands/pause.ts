import { post, resolveApp } from "../api.ts";
import { GREEN, RESET } from "../format.ts";

export async function pause(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd pause <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/pause`);

  if (result.ok) {
    console.log(`${GREEN}Paused ${app.name}${RESET}`);
  } else {
    console.error(`Failed: ${result.error || "unknown error"}`);
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
  const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/unpause`);

  if (result.ok) {
    console.log(`${GREEN}Unpaused ${app.name}${RESET}`);
  } else {
    console.error(`Failed: ${result.error || "unknown error"}`);
    process.exit(1);
  }
}
