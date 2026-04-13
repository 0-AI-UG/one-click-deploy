import { get, post, resolveApp } from "../api.ts";
import { GREEN, RESET } from "../format.ts";

interface Deployment {
  id: number;
  status: string;
  git_commit: string;
  image_tag: string;
  created_at: string;
}

export async function rollback(args: string[]): Promise<void> {
  const appName = args[0];
  if (!appName) {
    console.error("Usage: ocd rollback <app>");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const deployments = await get<Deployment[]>(`/api/apps/${app.id}/deployments`);

  // Find the previous successful deployment (skip the current one)
  const previous = deployments.filter((d) => d.status === "deployed").slice(1)[0];
  if (!previous) {
    console.error("No previous deployment to roll back to.");
    process.exit(1);
  }

  console.log(`Rolling back ${app.name} to deployment #${previous.id}...`);
  const result = await post<{ ok: boolean; error?: string }>(`/api/apps/${app.id}/rollback`, {
    deployment_id: previous.id,
  });

  if (result.ok) {
    console.log(`${GREEN}Rolled back ${app.name}${RESET}`);
  } else {
    console.error(`Failed: ${result.error || "unknown error"}`);
    process.exit(1);
  }
}
