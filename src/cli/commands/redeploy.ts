import { post, resolveApp } from "../api.ts";
import { GREEN, RED, RESET } from "../format.ts";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function redeploy(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd redeploy <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  console.log(`Redeploying ${app.name}...`);

  try {
    const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/redeploy`);
    if (result.ok) {
      console.log(`${GREEN}Redeploy complete for ${app.name}${RESET}`);
    } else {
      console.error(`\n${RED}Redeploy failed: ${result.error || "unknown error"}${RESET}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n${RED}Redeploy failed: ${errMsg(err)}${RESET}`);
    process.exit(1);
  }
}
