// Single source of truth for the running backend's version, read from
// package.json at runtime. The server and engine run from source (the repo,
// including package.json, is present in the image at /app), so a plain fs read
// keeps this in lockstep with package.json without a build step.
//
// The CLI is compiled with `bun build --compile` and cannot read package.json
// at runtime, so it injects its version at build time via --define
// (see scripts/build-cli.ts) rather than importing this module.
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dir, "../../package.json"), "utf8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION: string = readVersion();
