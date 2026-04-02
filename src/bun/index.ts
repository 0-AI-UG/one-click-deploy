import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun";
import type { DeployAppRPC } from "../shared/rpc.ts";
import * as db from "./db.ts";
import {
  deploy,
  destroyApp,
  destroyServer,
  getServersWithApps,
  restartApp,
  pauseApp,
  unpauseApp,
  redeployApp,
  updateAppEnv,
  rollbackApp,
} from "./deploy.ts";
import * as hetzner from "./hetzner.ts";
import * as github from "./github.ts";
import { getTokens, maskToken, setSecret, getSecret, deleteSecret } from "./keychain.ts";
import { validateHetznerToken, validateGitHubPat } from "./validate.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [rpc:${context}]`, ...args);
}

const rpc = BrowserView.defineRPC<DeployAppRPC>({
  maxRequestTime: 600_000,
  handlers: {
    requests: {
      getServers: async (_params: {}) => {
        log("getServers", "Fetching servers with apps...");
        const result = getServersWithApps();
        log("getServers", `Returned ${result.length} servers`);
        return result;
      },

      getApps: async (_params: {}) => {
        log("getApps", "Fetching all apps...");
        const result = db.getApps();
        log("getApps", `Returned ${result.length} apps`);
        return result;
      },

      getSettings: async (_params: {}) => {
        log("getSettings", "Loading settings...");
        const s = db.getSettings();
        const tokens = await getTokens();
        return {
          hetzner_api_token: maskToken(tokens.hetzner_api_token),
          hetzner_dns_token: maskToken(tokens.hetzner_dns_token),
          github_pat: maskToken(tokens.github_pat),
          dns_zone_id: s.dns_zone_id ?? "",
          default_server_type: s.default_server_type ?? "cpx12",
          default_location: s.default_location ?? "nbg1",
        };
      },

      saveSettings: async (settings: Record<string, string>) => {
        log("saveSettings", "Saving settings:", Object.keys(settings));
        for (const [key, value] of Object.entries(settings)) {
          if (key === "hetzner_api_token" || key === "hetzner_dns_token") {
            // Skip masked values (don't overwrite with mask)
            if (value.includes("...") || value === "****") continue;
            if (value) {
              const tokenValidation = validateHetznerToken(value);
              if (!tokenValidation.valid) {
                throw new Error(`${key}: ${tokenValidation.error}`);
              }
              await setSecret(key, value);
            }
          } else if (key === "github_pat") {
            if (value.includes("...") || value === "****") continue;
            if (value) {
              const patValidation = validateGitHubPat(value);
              if (!patValidation.valid) {
                throw new Error(`GitHub token: ${patValidation.error}`);
              }
              await setSecret(key, value);
              // Verify the token was stored
              const stored = await getSecret(key);
              if (!stored) {
                throw new Error("Failed to save GitHub token to Keychain. Check that the app has Keychain access.");
              }
              log("saveSettings", `GitHub PAT saved (${value.length} chars)`);
            } else {
              // Allow clearing the token
              await deleteSecret(key);
            }
          } else {
            db.saveSetting(key, String(value));
          }
        }
        log("saveSettings", "Settings saved");
        return { ok: true };
      },

      deploy: async (req: any) => {
        log("deploy", "Starting deploy:", { app_name: req.app_name, git_repo: req.git_repo, domain: req.domain, server_id: req.server_id });
        const startTime = Date.now();
        const result = await deploy(req, (step, detail) => {
          log("deploy:progress", `[${step}] ${detail}`);
          try {
            mainWindow.webview.rpc!.send.deployProgress({
              app_name: req.app_name,
              step,
              detail,
            });
          } catch (err) {
            log("deploy:progress", "Failed to send progress to webview:", err);
          }
        });
        log("deploy", `Deploy finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`, result);
        return result;
      },

      destroyApp: async ({ app_id }: { app_id: number }) => {
        log("destroyApp", `Destroying app ${app_id}...`);
        const result = await destroyApp(app_id);
        log("destroyApp", `Result:`, result);
        return result;
      },

      deleteServer: async ({ server_id }: { server_id: number }) => {
        log("deleteServer", `Deleting server ${server_id}...`);
        const result = await destroyServer(server_id);
        log("deleteServer", `Result:`, result);
        return result;
      },

      refreshServers: async (_params: {}) => {
        log("refreshServers", "Refreshing server list...");
        const result = getServersWithApps();
        log("refreshServers", `Returned ${result.length} servers`);
        return result;
      },

      getDeployLog: async ({ app_id }: { app_id: number }) => {
        log("getDeployLog", `Fetching log for app ${app_id}`);
        return db.getDeployLog(app_id);
      },

      openExternal: async ({ url }: { url: string }) => {
        log("openExternal", url);
        Bun.spawn(["open", url]);
        return { ok: true };
      },

      // New handlers

      restartApp: async ({ app_id }: { app_id: number }) => {
        log("restartApp", `Restarting app ${app_id}...`);
        return await restartApp(app_id);
      },

      pauseApp: async ({ app_id }: { app_id: number }) => {
        log("pauseApp", `Pausing app ${app_id}...`);
        return await pauseApp(app_id);
      },

      unpauseApp: async ({ app_id }: { app_id: number }) => {
        log("unpauseApp", `Unpausing app ${app_id}...`);
        return await unpauseApp(app_id);
      },

      redeployApp: async ({ app_id, env_vars, auth_password }: { app_id: number; env_vars?: Record<string, string>; auth_password?: string | null }) => {
        log("redeployApp", `Redeploying app ${app_id}...`);
        return await redeployApp(app_id, (step, detail) => {
          try {
            mainWindow.webview.rpc!.send.deployProgress({
              app_name: `redeploy-${app_id}`,
              step,
              detail,
            });
          } catch {}
        }, env_vars, auth_password);
      },

      updateAppEnv: async ({ app_id, env_vars }: { app_id: number; env_vars: Record<string, string> }) => {
        log("updateAppEnv", `Updating env for app ${app_id}...`);
        return await updateAppEnv(app_id, env_vars);
      },

      getContainerLogs: async ({ app_id, tail }: { app_id: number; tail?: number }) => {
        log("getContainerLogs", `Fetching container logs for app ${app_id}`);
        try {
          const app = db.getApp(app_id);
          if (!app) return { logs: "", error: "App not found" };
          const server = db.getServer(app.server_id);
          if (!server) return { logs: "", error: "Server not found" };
          const logs = await hetzner.getContainerLogs(
            server.ipv4,
            app.name,
            tail ?? 100,
            server.ssh_host_key || undefined
          );
          return { logs };
        } catch (err) {
          return { logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      },

      getDeployments: async ({ app_id }: { app_id: number }) => {
        log("getDeployments", `Fetching deployments for app ${app_id}`);
        return db.getDeployments(app_id);
      },

      rollbackApp: async ({ app_id, deployment_id }: { app_id: number; deployment_id: number }) => {
        log("rollbackApp", `Rolling back app ${app_id} to deployment ${deployment_id}...`);
        return await rollbackApp(app_id, deployment_id);
      },

      enableWebhook: async ({ app_id, branch }: { app_id: number; branch?: string }) => {
        log("enableWebhook", `Enabling webhook for app ${app_id}...`);
        try {
          const app = db.getApp(app_id);
          if (!app) throw new Error("App not found");
          const server = db.getServer(app.server_id);
          if (!server) throw new Error("Server not found");

          const pat = await github.getGitHubPat();
          if (!pat) throw new Error("GitHub token not configured. Add it in Settings.");

          const webhookBranch = branch || "main";
          const webhookSecret = crypto.randomUUID();
          const hostKey = server.ssh_host_key || undefined;

          // Deploy webhook receiver + Caddy route on server
          await hetzner.deployWebhookReceiver(server.ipv4, hostKey);
          await hetzner.ensureWebhookCaddyRoute(server.ipv4, hostKey);

          // Configure this app's webhook on the server
          await hetzner.setupAppWebhook(
            server.ipv4, app.name, webhookSecret,
            app.host_port, webhookBranch, pat, hostKey
          );

          // Create GitHub webhook
          const webhook = await github.createWebhook({
            gitRepo: app.git_repo,
            appName: app.name,
            serverDomain: app.domain,
            webhookSecret,
            token: pat,
          });

          // Save to DB
          db.updateAppWebhook(app_id, true, webhookSecret, webhookBranch, String(webhook.id));

          log("enableWebhook", `Webhook enabled for app ${app_id}, GitHub webhook id=${webhook.id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("enableWebhook", `Failed:`, msg);
          return { ok: false, error: msg };
        }
      },

      disableWebhook: async ({ app_id }: { app_id: number }) => {
        log("disableWebhook", `Disabling webhook for app ${app_id}...`);
        try {
          const app = db.getApp(app_id);
          if (!app) throw new Error("App not found");
          const server = db.getServer(app.server_id);

          // Delete GitHub webhook
          if (app.github_webhook_id) {
            const pat = await github.getGitHubPat();
            if (pat) {
              try {
                await github.deleteWebhook({
                  gitRepo: app.git_repo,
                  webhookId: app.github_webhook_id,
                  token: pat,
                });
              } catch (err) {
                log("disableWebhook", `Failed to delete GitHub webhook: ${err instanceof Error ? err.message : err}`);
              }
            }
          }

          // Remove webhook config from server
          if (server) {
            const hostKey = server.ssh_host_key || undefined;
            await hetzner.removeAppWebhook(server.ipv4, app.name, hostKey);
          }

          // Update DB
          db.updateAppWebhook(app_id, false, "", app.webhook_branch || "main", "");

          log("disableWebhook", `Webhook disabled for app ${app_id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("disableWebhook", `Failed:`, msg);
          return { ok: false, error: msg };
        }
      },
    },
    messages: {},
  },
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Edit",
    submenu: [
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
]);

const mainWindow = new BrowserWindow({
  title: "One-Click Deploy",
  url: "views://mainview/index.html",
  frame: {
    width: 500,
    height: 500,
    x: 200,
    y: 100,
  },
  rpc,
});
