import { runAppOp } from "../ops.ts";

export async function pause(args: string[]): Promise<void> {
  await runAppOp({
    args,
    command: "pause",
    endpoint: "pause",
    verb: "Pause",
    done: "Paused",
  });
}

export async function unpause(args: string[]): Promise<void> {
  await runAppOp({
    args,
    command: "unpause",
    endpoint: "unpause",
    verb: "Unpause",
    done: "Unpaused",
  });
}
