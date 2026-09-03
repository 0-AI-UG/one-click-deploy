import { createWriteStream, existsSync, lstatSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { requireConfig } from "../config.ts";
import { BOLD, DIM, RED, RESET } from "../format.ts";
import { resolveTarget } from "./ssh.ts";

export type CopyArgs = {
  target: string;
  remotePath: string;
  destination: string;
  force: boolean;
  targetFlags: string[];
};

export function parseCopyArgs(args: string[]): CopyArgs {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 2) throw new Error("Expected a remote source and local destination");
  const separator = positional[0]!.indexOf(":");
  if (separator <= 0) throw new Error("Remote source must use <app|server>:/absolute/path");
  const target = positional[0]!.slice(0, separator);
  const remotePath = positional[0]!.slice(separator + 1);
  if (!remotePath.startsWith("/")) throw new Error("Remote path must be absolute");
  if (remotePath.includes("\0")) throw new Error("Remote path contains a NUL byte");
  const knownFlags = args.filter((arg) => arg.startsWith("--"));
  const unknown = knownFlags.filter((arg) =>
    arg !== "--force" && arg !== "--server" && !arg.startsWith("--replica=")
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  return {
    target,
    remotePath,
    destination: positional[1]!,
    force: args.includes("--force"),
    targetFlags: knownFlags.filter((arg) => arg !== "--force"),
  };
}

function outputPath(destination: string, remotePath: string): string {
  if (existsSync(destination) && lstatSync(destination).isDirectory()) {
    return path.join(destination, path.posix.basename(remotePath));
  }
  return destination;
}

export async function cp(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    console.error(`${BOLD}Usage:${RESET} ocd cp <app|server>:/absolute/path <local-path> [options]

Downloads one regular file from an app container or server without buffering it in the panel.

${BOLD}Options:${RESET}
  --force                       Replace an existing local file
  --server                      Resolve the source as a server
  --replica=<id>                Select a specific running app replica

${DIM}Remote-to-local copies only. The remote path must be absolute.${RESET}`);
    process.exit(args[0] ? 0 : 1);
  }

  const parsed = parseCopyArgs(args);
  const destination = path.resolve(outputPath(parsed.destination, parsed.remotePath));
  if (existsSync(destination) && !parsed.force) {
    throw new Error(`Refusing to overwrite ${destination}; pass --force to replace it`);
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(destination)}.ocd-part-${randomUUID()}`);
  const { wsTarget } = await resolveTarget([parsed.target, ...parsed.targetFlags]);
  const config = requireConfig();
  const response = await fetch(`${config.panel_url}/api/terminal/file`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target: wsTarget, path: parsed.remotePath }),
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`File download failed (HTTP ${response.status}): ${body.slice(0, 500)}`);
  }
  const expected = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Panel returned an invalid file size");

  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const reader = response.body.getReader();
  let received = 0;
  let nextProgress = 64 * 1024 * 1024;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!output.write(chunk)) await once(output, "drain");
      received += chunk.length;
      if (received >= nextProgress) {
        console.error(`${DIM}${received.toLocaleString("en-US")}/${expected.toLocaleString("en-US")} bytes${RESET}`);
        nextProgress += 64 * 1024 * 1024;
      }
    }
    output.end();
    await once(output, "close");
    if (received !== expected) throw new Error(`Incomplete download: received ${received}/${expected} bytes`);
    if (parsed.force && existsSync(destination)) await rm(destination, { force: true });
    await rename(temporary, destination);
    console.log(`${destination} (${received.toLocaleString("en-US")} bytes)`);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}
