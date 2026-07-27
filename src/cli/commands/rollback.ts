import { get, resolveApp } from "../api.ts";
import { runAppOp } from "../ops.ts";

interface Deployment {
  id: number;
  status: string;
  git_commit: string;
  image_tag: string;
  created_at: string;
}

export function parseRollbackArgs(args: string[]): {
  appName?: string;
  deploymentId?: number;
} {
  const appName = args.find((arg) => !arg.startsWith("-"));
  const deploymentArg = args.find((arg) => arg.startsWith("--deployment="));
  if (!deploymentArg) return { appName };
  const raw = deploymentArg.slice("--deployment=".length);
  const deploymentId = Number(raw);
  if (!Number.isInteger(deploymentId) || deploymentId <= 0) {
    throw new Error("--deployment must be a positive deployment ID");
  }
  return { appName, deploymentId };
}

export async function rollback(args: string[]): Promise<void> {
  const { appName, deploymentId } = parseRollbackArgs(args);
  if (!appName) {
    console.error("Usage: ocd rollback <app> [--deployment=<id>]");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const deployments = await get<Deployment[]>(`/api/apps/${app.id}/deployments`);

  // With no explicit ID, preserve the original convenience behavior: select
  // the previous successful deployment after the currently deployed row.
  const target = deploymentId !== undefined
    ? deployments.find((d) => d.id === deploymentId)
    : deployments.filter((d) => d.status === "deployed").slice(1)[0];
  if (!target) {
    if (deploymentId !== undefined) {
      console.error(`Deployment #${deploymentId} was not found for ${app.name}.`);
      process.exit(1);
    }
    console.error("No previous deployment to roll back to.");
    process.exit(1);
  }
  if (target.status === "failed") {
    console.error(`Deployment #${target.id} failed and cannot be rolled back to.`);
    process.exit(1);
  }

  console.log(`Rolling back ${app.name} to deployment #${target.id}...`);
  await runAppOp({
    args,
    command: "rollback",
    app,
    endpoint: "rollback",
    body: { deployment_id: target.id },
    verb: "Rollback",
    done: "Rolled back",
  });
}
