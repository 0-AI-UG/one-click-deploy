import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun";
import type { DeployAppRPC } from "../shared/rpc.ts";
import * as db from "./db.ts";
import {
  deploy,
  destroyApp,
  destroyServer,
  getServersWithApps,
  restartApp,
  redeployApp,
  updateAppEnv,
  rollbackApp,
} from "./deploy.ts";
import * as hetzner from "./hetzner.ts";
import { getTokens, maskToken, setSecret } from "./keychain.ts";
import { validateHetznerToken } from "./validate.ts";

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

      redeployApp: async ({ app_id }: { app_id: number }) => {
        log("redeployApp", `Redeploying app ${app_id}...`);
        return await redeployApp(app_id, (step, detail) => {
          try {
            mainWindow.webview.rpc!.send.deployProgress({
              app_name: `redeploy-${app_id}`,
              step,
              detail,
            });
          } catch {}
        });
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
