import { runAppOp } from "../ops.ts";

export async function restart(args: string[]): Promise<void> {
  await runAppOp({
    args,
    command: "restart",
    endpoint: "restart",
    verb: "Restart",
    done: "Restarted",
  });
}
