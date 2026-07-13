import { runAppOp } from "../ops.ts";

export async function redeploy(args: string[]): Promise<void> {
  await runAppOp({
    args,
    command: "redeploy",
    endpoint: "redeploy",
    verb: "Redeploy",
    done: "Redeployed",
    progress: "Redeploying",
    queued: true,
  });
}
