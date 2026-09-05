// Headless panel bootstrap: when OCD_AUTO_DEPLOY is set, read a config,
// run bootstrapPanel, stream progress to stdout, and exit. Used by the
// Docker one-liner so the operator never has to open a browser on the
// local (bootstrap) instance.
import { readFileSync } from "fs";
import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";
import { requireInfrastructureProvider } from "../shared/providers/index.ts";
import {
  newProviderConnectionId,
  providerSecretKey,
  saveProviderAssignments,
  saveProviderConnections,
} from "../shared/provider-connections.ts";
import { bootstrapPanel } from "./deploy/panel.ts";
import { bootstrapPanelOnConnectedHost } from "./deploy/panel-connected.ts";

export type AutoDeployConfig = {
  provisioner?: string;
  provisioner_token?: string;
  connected_host?: {
    name: string;
    management_address: string;
    routing_address: string;
    ssh_host_key: string;
    ssh_private_key: string;
  };
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

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
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
  const provisioner = typeof cfg.provisioner === "string" ? cfg.provisioner.trim() : "";
  const connectedHost = cfg.connected_host as Record<string, unknown> | undefined;
  if (!!provisioner === !!connectedHost) {
    throw new Error("auto-deploy requires exactly one of provisioner or connected_host");
  }
  let providerToken: string | undefined;
  if (provisioner) {
    const tokenEnv = typeof cfg.provisioner_token_env === "string"
      ? cfg.provisioner_token_env
      : "OCD_PROVISIONER_TOKEN";
    providerToken = typeof cfg.provisioner_token === "string" ? cfg.provisioner_token : process.env[tokenEnv];
    if (!providerToken) throw new Error(`auto-deploy requires ${tokenEnv}; keep provider credentials out of panel.json`);
  } else {
    for (const key of ["name", "management_address", "routing_address", "ssh_host_key", "ssh_private_key"]) {
      if (typeof connectedHost?.[key] !== "string" || !String(connectedHost[key]).trim()) {
        throw new Error(`auto-deploy connected_host missing field: ${key}`);
      }
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(connectedHost!.name))) {
      throw new Error("auto-deploy connected_host.name must be a lowercase server slug");
    }
    for (const key of ["management_address", "routing_address"] as const) {
      if (!isIpv4(String(connectedHost![key]))) {
        throw new Error(`auto-deploy connected_host.${key} must be an IPv4 address`);
      }
    }
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
  return { ...cfg, provisioner: provisioner || undefined, provisioner_token: providerToken } as unknown as AutoDeployConfig;
}

export async function runAutoDeploy(
  config: AutoDeployConfig,
): Promise<{ ok: boolean; error?: string }> {
  log(
    `Starting headless panel bootstrap for ${config.domain ?? "an auto-assigned <ip>.nip.io domain"}`,
  );

  const provider = config.provisioner ? requireInfrastructureProvider(config.provisioner) : null;

  // Fail fast on a bad token: validate the format, then confirm it actually
  // authenticates against the selected provider BEFORE we start provisioning
  // anything. Otherwise a typo surfaces as a cryptic mid-pipeline error after
  // a server has already been created.
  if (provider) {
    const validation = provider.validateToken(config.provisioner_token!);
    if (!validation.valid) {
      const error = `Invalid ${provider.name} API token: ${validation.error}`;
      log(`✗ ${error}`);
      return { ok: false, error };
    }
    try {
      log("Verifying provider token...");
      await provider.verifyToken(config.provisioner_token!);
    } catch (err) {
      const error = (err as Error).message;
      log(`✗ Provider token verification failed: ${error}`);
      return { ok: false, error };
    }
  }

  // Generate the JWT secret FIRST, then export it into the environment
  // BEFORE touching secretStore. secret-store derives its AES-GCM key from
  // process.env.JWT_SECRET via HKDF, so this guarantees the provider token
  // we're about to encrypt can be decrypted by the hosted instance (which
  // will run with the same JWT_SECRET). No re-encryption dance required.
  const jwtSecret =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  process.env.JWT_SECRET = jwtSecret;

  if (provider) {
    const id = newProviderConnectionId(provider.id as "hetzner");
    saveProviderConnections([{
      id,
      kind: provider.id as "hetzner",
      name: provider.name,
      config: {},
      created_at: new Date().toISOString(),
    }]);
    saveProviderAssignments({ infrastructure: id, object_storage: "" });
    await secretStore.set(providerSecretKey(id, "api_token"), config.provisioner_token!);
  }
  // Reuse bootstrap choices as lazy provisioning defaults. A first manifest
  // deploy can now add runtime/build capacity without asking for these values
  // again; credentials remain encrypted in secretStore.
  db.saveSetting("default_server_type", config.server_type || "cx23");
  db.saveSetting("default_location", config.server_location || "nbg1");
  if (config.default_domain_suffix) {
    db.saveSetting("default_domain_suffix", config.default_domain_suffix);
  }

  const panelOptions = {
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
      volumePath: "/app/data",
  };
  const progress = (step: string, detail: string) => console.log(`[${step}] ${detail}`);
  const result = provider
    ? await bootstrapPanel({
        ...panelOptions,
        serverType: config.server_type || "cx23",
        serverLocation: config.server_location || "nbg1",
        volumeSize: config.volume_size ?? 10,
        providerId: provider.id,
      }, progress)
    : await bootstrapPanelOnConnectedHost({
        ...panelOptions,
        host: {
          name: config.connected_host!.name,
          managementAddress: config.connected_host!.management_address,
          routingAddress: config.connected_host!.routing_address,
          sshHostKey: config.connected_host!.ssh_host_key,
        },
      }, progress);

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
