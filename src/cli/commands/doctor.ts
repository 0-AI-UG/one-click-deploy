import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDeployReadiness } from "../deploy-readiness.ts";
import { manifestRepoLocation, readManifest } from "../manifest.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../format.ts";

const icon = (status: string) => status === "ready" ? `${GREEN}✓${RESET}` : status === "blocked" ? `${RED}✗${RESET}` : `${YELLOW}!${RESET}`;

export async function doctor(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${BOLD}Usage:${RESET} ocd doctor [manifest]\n\nChecks deploy readiness without changing infrastructure or credentials.`);
    return;
  }
  const path = args.find((arg) => !arg.startsWith("-")) || ".ocd-deploy.json";
  let repository: string | undefined;
  let image: string | undefined;
  if (existsSync(path)) {
    const location = manifestRepoLocation(path);
    const parsed = JSON.parse(readFileSync(location.fullPath, "utf8")) as { apps?: Record<string, { manifest?: string }> };
    if (parsed.apps) {
      const first = Object.values(parsed.apps)[0]?.manifest;
      if (!first) throw new Error("Stack manifest contains no app manifests");
      const manifest = readManifest(resolve(dirname(location.fullPath), first));
      repository = manifest.build?.repository;
      image = manifest.build?.image_repository ?? manifest.image;
    } else {
      const manifest = readManifest(location.fullPath);
      repository = manifest.build?.repository;
      image = manifest.build?.image_repository ?? manifest.image;
    }
    console.log(`${DIM}Manifest:${RESET} ${location.path}`);
  }
  const result = await getDeployReadiness(repository, image);
  const buildDelivery = !!repository;
  console.log(`\n${BOLD}Deploy readiness${RESET}`);
  console.log(`${icon(result.provider.status)} Provider       ${result.provider.configured ? "connected" : "not connected"}`);
  console.log(`${icon(result.defaults.status)} Defaults       ${result.defaults.server_type && result.defaults.location ? `${result.defaults.server_type} / ${result.defaults.location}` : "not configured"}`);
  console.log(`${icon(result.worker.status)} Build worker   ${buildDelivery ? `${result.worker.online} online, ${result.worker.total} registered` : "not required for prebuilt images"}`);
  console.log(`${icon(result.registry.status)} Registry       ${result.registry.configured ? `${result.registry.scope} as ${result.registry.username}` : buildDelivery ? "not connected" : "anonymous pull unless the image is private"}`);
  console.log(`${icon(result.source.status)} Source access  ${buildDelivery ? (result.source.configured ? result.source.host : `${result.source.host} (public repositories only)`) : "not required for prebuilt images"}`);
  if (result.actions.length) {
    console.log(`\n${BOLD}Next actions${RESET}`);
    result.actions.forEach((action) => console.log(`  ${action.label}: ${BOLD}${action.command}${RESET}`));
  } else console.log(`\n${GREEN}Ready to deploy.${RESET}`);
}
