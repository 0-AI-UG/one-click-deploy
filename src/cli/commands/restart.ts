import { post, resolveApp } from "../api.ts";
import { GREEN, RESET } from "../format.ts";

export async function restart(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd restart <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/restart`);

  if (result.ok) {
    console.log(`${GREEN}Restarted ${app.name}${RESET}`);
  } else {
    console.error(`Failed: ${result.error || "unknown error"}`);
    process.exit(1);
  }
}
