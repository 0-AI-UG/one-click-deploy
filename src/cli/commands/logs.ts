import { get, resolveApp } from "../api.ts";

function parseFlag(args: string[], name: string): string | undefined {
  for (const arg of args) {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}

export async function logs(args: string[]): Promise<void> {
  const appName = args.find((a) => !a.startsWith("--"));
  if (!appName) {
    console.error("Usage: ocd logs <app> [--tail=100]");
    process.exit(1);
  }

  const app = await resolveApp(appName);
  const tail = parseFlag(args, "tail") || "100";
  const data = await get<{ logs: string; error?: string }>(`/api/apps/${app.id}/logs?tail=${tail}`);

  if (data.error) {
    console.error(`Error: ${data.error}`);
    process.exit(1);
  }

  if (data.logs) {
    process.stdout.write(data.logs);
    // Ensure trailing newline
    if (!data.logs.endsWith("\n")) process.stdout.write("\n");
  }
}
