#!/usr/bin/env bun
// Bootstrap the panel: pull the latest image from GHCR and run it with a
// local panel.json mounted as the auto-deploy config. The container
// provisions a Hetzner server, deploys the panel, and exits.
//
// Usage:
//   bun run scripts/bootstrap.ts [path/to/panel.json]
//
// Defaults to ./panel.json. Copy example.panel.json and fill it in first.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const IMAGE = process.env.OCD_IMAGE || "ghcr.io/0-ai-ug/one-click-deploy:latest";
const configPath = resolve(process.argv[2] || "panel.json");

if (!existsSync(configPath)) {
  console.error(`error: config file not found at ${configPath}`);
  console.error(`copy example.panel.json to panel.json and fill in your values.`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<void> {
  console.log(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`command exited with code ${code}`);
    process.exit(code);
  }
}

await run(["docker", "pull", IMAGE]);
await run([
  "docker", "run", "--rm",
  "-v", `${configPath}:/config.json:ro`,
  "-e", "OCD_AUTO_DEPLOY=/config.json",
  IMAGE,
]);
