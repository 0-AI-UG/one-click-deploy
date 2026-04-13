import { post, resolveApp } from "../api.ts";
import { GREEN, RESET } from "../format.ts";

export async function redeploy(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd redeploy <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  console.log(`Redeploying ${app.name}...`);

  const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/redeploy`);

  if (result.ok) {
    console.log(`${GREEN}Redeploy triggered for ${app.name}${RESET}`);
  } else {
    console.error(`Failed: ${result.error || "unknown error"}`);
    process.exit(1);
  }
}
