#!/usr/bin/env bun
// Bootstrap the panel: pull the latest image from GHCR and run it with a
// local panel.json mounted as the auto-deploy config. The container
// asks the selected infrastructure adapter to provision a server, deploys the
// panel, and exits.
//
// Usage:
//   bun run scripts/bootstrap.ts [path/to/panel.json]
//
// Defaults to ./panel.json. Copy example.panel.json and fill it in first.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const IMAGE = process.env.OCD_IMAGE || "ghcr.io/0-ai-ug/open-cli-deployment:latest";
const configPath = resolve(process.argv[2] || "panel.json");

if (!existsSync(configPath)) {
  console.error(`error: config file not found at ${configPath}`);
  console.error(`copy example.panel.json to panel.json and fill in your values.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  provisioner?: string;
  connected_host?: { ssh_private_key?: string };
};
if (config.provisioner && !process.env.OCD_PROVISIONER_TOKEN) {
  console.error("error: OCD_PROVISIONER_TOKEN is required in the environment");
  console.error("keep provider credentials out of panel.json; for example: OCD_PROVISIONER_TOKEN=... bun run bootstrap");
  process.exit(1);
}
const privateKeyPath = config.connected_host?.ssh_private_key
  ? resolve(dirname(configPath), config.connected_host.ssh_private_key)
  : "";
if (config.connected_host && (!privateKeyPath || !existsSync(privateKeyPath))) {
  console.error("error: connected_host.ssh_private_key must point to an existing private key");
  process.exit(1);
}
if (privateKeyPath && !existsSync(`${privateKeyPath}.pub`)) {
  console.error(`error: public key not found at ${privateKeyPath}.pub`);
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
const dockerArgs = [
  "docker", "run", "--rm",
  "-v", `${configPath}:/config.json:ro`,
  "-e", "OCD_AUTO_DEPLOY=/config.json",
];
if (config.provisioner) dockerArgs.push("-e", "OCD_PROVISIONER_TOKEN");
if (privateKeyPath) {
  dockerArgs.push("--user", "root");
  dockerArgs.push("-v", `${privateKeyPath}:/app/data/ssh/id_ed25519:ro`);
  dockerArgs.push("-v", `${privateKeyPath}.pub:/app/data/ssh/id_ed25519.pub:ro`);
}
dockerArgs.push(IMAGE);
await run(dockerArgs);
