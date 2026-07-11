import { get, post, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { GREEN, RED, RESET } from "../format.ts";

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
  const { op_id } = await post<{ op_id: number }>(`/api/apps/${app.id}/rollback`, {
    deployment_id: previous.id,
  });
  const result = await followOp(op_id);

  if (result.ok) {
    console.log(`${GREEN}Rolled back ${app.name}${RESET}`);
  } else {
    console.error(`${RED}Rollback failed: ${result.error || "unknown error"}${RESET}`);
    process.exit(1);
  }
}
