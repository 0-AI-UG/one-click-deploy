import { get, resolveApp } from "../api.ts";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";
import { expectRecord } from "../response.ts";

export async function logs(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    tail: { type: "string" },
    replica: { type: "string" },
  }, { maxPositionals: 1 });
  const appName = parsed.positionals[0];
  if (!appName) {
    console.error("Usage: ocd logs <app> [--tail=100] [--replica=<id>]");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const tail = positiveIntegerFlag(parsed.flags.tail, "tail", { defaultValue: 100, max: 10_000 })!;
  const replica = parsed.flags.replica;
  if (replica !== undefined && typeof replica !== "string") throw new Error("--replica requires a value");
  const params = new URLSearchParams({ tail: String(tail) });
  if (replica) params.set("replica_id", replica);
  const payload = await get<unknown>(
    `/api/apps/${app.id}/logs?${params.toString()}`,
  );
  const data = expectRecord(payload, "App logs request") as { logs?: unknown; error?: unknown };

  if (typeof data.error === "string" && data.error) {
    console.error(`Error: ${data.error}`);
    process.exit(1);
  }

  if (typeof data.logs !== "string") throw new Error("App logs request returned a malformed response (missing logs)");
  if (data.logs) {
    process.stdout.write(data.logs);
    // Ensure trailing newline
    if (!data.logs.endsWith("\n")) process.stdout.write("\n");
  } else console.log("(no logs)");
}
