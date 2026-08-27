// Headless panel bootstrap: when OCD_AUTO_DEPLOY is set, read a config,
// run bootstrapPanel, stream progress to stdout, and exit. Used by the
// Docker one-liner so the operator never has to open a browser on the
// local (bootstrap) instance.
import { readFileSync } from "fs";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { hetzner } from "../shared/providers/index.ts";
import { bootstrapPanel } from "./deploy/panel.ts";

export type AutoDeployConfig = {
  hetzner_api_token: string;
  panel_image_ref: string;
  /**
   * Public domain for the panel. Optional: when omitted, bootstrap derives a
   * `<server-ip>.nip.io` domain after the server is created and serves it with
   * a self-signed (Traefik default) cert — no DNS setup or real domain needed.
   */
  domain?: string;
  server_type?: string;
  server_location?: string;
  default_domain_suffix?: string;
  app_name?: string;
  volume_size?: number;
};

function log(...args: unknown[]) {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`OCD_AUTO_DEPLOY is not valid JSON: ${(err as Error).message}`);
  }

  const cfg = parsed as Record<string, unknown>;
  if (!cfg.hetzner_api_token || typeof cfg.hetzner_api_token !== "string") {
    throw new Error("auto-deploy config missing required field: hetzner_api_token");
  }
  if (typeof cfg.panel_image_ref !== "string" ||
      !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(cfg.panel_image_ref)) {
    throw new Error("auto-deploy config missing immutable field: panel_image_ref");
  }
  // `domain` is optional (omit it for a self-signed <ip>.nip.io panel), but if
  // present it must be a string.
  if (cfg.domain !== undefined && typeof cfg.domain !== "string") {
    throw new Error("auto-deploy config field 'domain' must be a string");
  }
  return cfg as unknown as AutoDeployConfig;
}

export async function runAutoDeploy(
  config: AutoDeployConfig,
): Promise<{ ok: boolean; error?: string }> {
  log(
    `Starting headless panel bootstrap for ${config.domain ?? "an auto-assigned <ip>.nip.io domain"}`,
  );

  // Fail fast on a bad token: validate the format, then confirm it actually
  // authenticates against the Hetzner API BEFORE we start provisioning
  // anything. Otherwise a typo surfaces as a cryptic mid-pipeline error after
  // a server has already been created.
  const validation = hetzner.validateToken(config.hetzner_api_token);
  if (!validation.valid) {
    const error = `Invalid ${hetzner.name} API token: ${validation.error}`;
    log(`✗ ${error}`);
    return { ok: false, error };
  }
  try {
    log("Verifying provider token...");
    await hetzner.verifyToken(config.hetzner_api_token);
  } catch (err) {
    const error = (err as Error).message;
    log(`✗ Provider token verification failed: ${error}`);
    return { ok: false, error };
  }

  // Generate the JWT secret FIRST, then export it into the environment
  // BEFORE touching secretStore. secret-store derives its AES-GCM key from
  // process.env.JWT_SECRET via HKDF, so this guarantees the provider token
  // we're about to encrypt can be decrypted by the hosted instance (which
  // will run with the same JWT_SECRET). No re-encryption dance required.
  const jwtSecret =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  process.env.JWT_SECRET = jwtSecret;

  await secretStore.set(hetzner.tokenKey, config.hetzner_api_token);
  if (config.default_domain_suffix) {
    db.saveSetting("default_domain_suffix", config.default_domain_suffix);
  }

  const result = await bootstrapPanel(
    {
      appName: config.app_name || "ocd-panel",
      domain: config.domain,
      imageRef: config.panel_image_ref,
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
    },
    (step, detail) => console.log(`[${step}] ${detail}`),
  );

  if (result.ok) {
    log(`✓ Panel deployed to https://${result.domain}`);
    log(`  Server IP: ${result.serverIp}`);
    if (result.internalTls) {
      log("  This domain uses a self-signed certificate (.nip.io) — your");
      log("  browser will warn on first visit; that's expected.");
      log(`  Open https://${result.domain} and finish setup to create your admin account.`);
    } else if (result.dnsResolved) {
      log(`  Open https://${result.domain} and finish setup to create your admin account.`);
    } else {
      log("  ⚠ DNS is not pointing at the server yet, so the site won't load");
      log("    and no TLS certificate can be issued until you fix that.");
      log(`      Create a DNS A record:  ${result.domain}  →  ${result.serverIp}`);
      log("    TLS is then issued automatically once DNS propagates (usually");
      log(`    a few minutes). Then open https://${result.domain} to create your admin account.`);
    }
  } else {
    log(`✗ Bootstrap failed: ${result.error}`);
  }
  return { ok: result.ok, error: result.error };
}
