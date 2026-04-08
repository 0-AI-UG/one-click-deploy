// Headless self-deploy: when OCD_AUTO_DEPLOY is set, load a config (inline
// JSON or file path), run the full self-deploy pipeline, stream progress to
// stdout, and exit. Used by the Docker one-liner bootstrap so the user
// never has to open a browser on the local instance.
import { readFileSync } from "fs";
import type { DeployRequest } from "../shared/rpc.ts";
import * as db from "./db.ts";
import { secretStore } from "./secret-store.ts";
import { deploy } from "./deploy/deploy.ts";

export type AutoDeployConfig = {
  hetzner_token: string;
  domain: string;
  server_type?: string;
  server_location?: string;
  github_pat?: string;
  dns_zone_id?: string;
  app_name?: string;
  volume_size?: number;
  webhook_branch?: string;
};

function log(...args: any[]) {
  console.log(`[auto-deploy]`, ...args);
}

/**
 * Parse the OCD_AUTO_DEPLOY env value. Accepts either:
 *   - inline JSON (value starts with "{")
 *   - a file path to a JSON file
 */
export function loadAutoDeployConfig(raw: string): AutoDeployConfig {
  const trimmed = raw.trim();
  let jsonText: string;
  if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    log(`Reading config from file: ${trimmed}`);
    jsonText = readFileSync(trimmed, "utf-8");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`OCD_AUTO_DEPLOY is not valid JSON: ${(err as Error).message}`);
  }

  if (!parsed.hetzner_token || typeof parsed.hetzner_token !== "string") {
    throw new Error("auto-deploy config missing required field: hetzner_token");
  }
  if (!parsed.domain || typeof parsed.domain !== "string") {
    throw new Error("auto-deploy config missing required field: domain");
  }
  return parsed as AutoDeployConfig;
}

export async function runAutoDeploy(config: AutoDeployConfig): Promise<{ ok: boolean; error?: string }> {
  log(`Starting headless self-deploy for ${config.domain}`);

  // Seed secrets into the local (bootstrap) DB so the deploy pipeline can
  // read them via the usual getTokens() path, and so the re-encryption
  // handoff picks them up into the hosted instance's snapshot.
  await secretStore.set("hetzner_api_token", config.hetzner_token);
  if (config.github_pat) {
    await secretStore.set("github_pat", config.github_pat);
  }
  if (config.dns_zone_id) {
    db.saveSetting("dns_zone_id", config.dns_zone_id);
  }

  const jwtSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  const req: DeployRequest = {
    app_name: config.app_name || "ocd-panel",
    domain: config.domain,
    git_repo: "https://github.com/0-AI-UG/one-click-deploy.git",
    container_port: 3001,
    env_vars: {
      NODE_ENV: "production",
      OCD_DATA_DIR: "/app/data",
      PORT: "3001",
      JWT_SECRET: jwtSecret,
    },
    server_type: config.server_type || "cx22",
    server_location: config.server_location || "nbg1",
    volume_size: config.volume_size ?? 10,
    volume_path: "/app/data",
    webhook_enabled: !!config.github_pat,
    webhook_branch: config.webhook_branch || "main",
    replicas: 1,
    self_deploy: true,
  };

  const result = await deploy(req, (step, detail) => {
    console.log(`[${step}] ${detail}`);
  });

  if (result.ok) {
    log(`✓ Panel deployed to https://${config.domain}`);
    log(`  Open the domain and finish setup to create your admin account.`);
  } else {
    log(`✗ Deploy failed: ${result.error}`);
  }
  return result;
}
