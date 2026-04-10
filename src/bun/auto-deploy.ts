// Headless panel bootstrap: when OCD_AUTO_DEPLOY is set, read a config,
// run bootstrapPanel, stream progress to stdout, and exit. Used by the
// Docker one-liner so the operator never has to open a browser on the
// local (bootstrap) instance.
import { readFileSync } from "fs";
import * as db from "./db.ts";
import { secretStore } from "./secret-store.ts";
import { bootstrapPanel } from "./deploy/panel.ts";

export type AutoDeployConfig = {
  hetzner_token: string;
  domain: string;
  server_type?: string;
  server_location?: string;
  dns_zone_id?: string;
  app_name?: string;
  volume_size?: number;
  webhook_branch?: string;
};

function log(...args: any[]) {
  console.log("[auto-deploy]", ...args);
}

/**
 * Parse OCD_AUTO_DEPLOY. Accepts either inline JSON (value starts with "{")
 * or a path to a JSON file.
 */
export function loadAutoDeployConfig(raw: string): AutoDeployConfig {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : (log(`Reading config from file: ${trimmed}`), readFileSync(trimmed, "utf-8"));

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

export async function runAutoDeploy(
  config: AutoDeployConfig,
): Promise<{ ok: boolean; error?: string }> {
  log(`Starting headless panel bootstrap for ${config.domain}`);

  // Generate the JWT secret FIRST, then export it into the environment
  // BEFORE touching secretStore. secret-store derives its AES-GCM key from
  // process.env.JWT_SECRET via HKDF, so this guarantees the Hetzner token
  // we're about to encrypt can be decrypted by the hosted instance (which
  // will run with the same JWT_SECRET). No re-encryption dance required.
  const jwtSecret =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  process.env.JWT_SECRET = jwtSecret;

  await secretStore.set("hetzner_api_token", config.hetzner_token);
  if (config.dns_zone_id) {
    db.saveSetting("dns_zone_id", config.dns_zone_id);
  }

  const result = await bootstrapPanel(
    {
      appName: config.app_name || "ocd-panel",
      domain: config.domain,
      gitRepo: "https://github.com/0-AI-UG/one-click-deploy.git",
      containerPort: 3001,
      envVars: {
        NODE_ENV: "production",
        OCD_DATA_DIR: "/app/data",
        PORT: "3001",
        JWT_SECRET: jwtSecret,
      },
      serverType: config.server_type || "cx23",
      serverLocation: config.server_location || "nbg1",
      volumeSize: config.volume_size ?? 10,
      volumePath: "/app/data",
      dnsZoneId: config.dns_zone_id,
      webhookBranch: config.webhook_branch || "main",
    },
    (step, detail) => console.log(`[${step}] ${detail}`),
  );

  if (result.ok) {
    log(`✓ Panel deployed to https://${result.domain}`);
    log("  Open the domain and finish setup to create your admin account.");
  } else {
    log(`✗ Bootstrap failed: ${result.error}`);
  }
  return result;
}
