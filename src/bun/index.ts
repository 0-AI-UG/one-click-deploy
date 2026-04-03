import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun";
import type { DeployAppRPC } from "../shared/rpc.ts";
import * as db from "./db.ts";
import {
  deploy,
  destroyApp,
  destroyServer,
  getServersWithApps,
  restartApp,
  recreateAppContainer,
  pauseApp,
  unpauseApp,
  redeployApp,
  updateAppEnv,
  rollbackApp,
} from "./deploy/index.ts";
import { scaleApp, collectMetrics } from "./scale.ts";
import * as hetzner from "./hetzner/index.ts";
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
          const logs = app.deploy_mode === "compose"
            ? await hetzner.getComposeLogs(server.ipv4, app.name, tail ?? 100, server.ssh_host_key || undefined)
            : await hetzner.getContainerLogs(server.ipv4, app.name, tail ?? 100, server.ssh_host_key || undefined);
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
            app.host_port, webhookBranch, pat, hostKey,
            app.deploy_mode, app.compose_file || undefined,
            app.container_port, app.volume_mount || undefined
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

      scaleApp: async ({ app_id, replicas }: { app_id: number; replicas: number }) => {
        log("scaleApp", `Scaling app ${app_id} to ${replicas} replicas...`);
        return await scaleApp(app_id, replicas, (step, detail) => {
          try {
            mainWindow.webview.rpc!.send.deployProgress({
              app_name: `scale-${app_id}`,
              step,
              detail,
            });
          } catch {}
        });
      },

      getReplicas: async ({ app_id }: { app_id: number }) => {
        log("getReplicas", `Fetching replicas for app ${app_id}`);
        return db.getReplicas(app_id);
      },

      getScalingEvents: async ({ app_id }: { app_id: number }) => {
        log("getScalingEvents", `Fetching scaling events for app ${app_id}`);
        return db.getScalingEvents(app_id);
      },

      updateScalingPolicy: async ({ app_id, min_replicas, max_replicas, autoscale_enabled, cpu_threshold, mem_threshold }: {
        app_id: number;
        min_replicas: number;
        max_replicas: number;
        autoscale_enabled: boolean;
        cpu_threshold: number;
        mem_threshold: number;
      }) => {
        log("updateScalingPolicy", `Updating scaling policy for app ${app_id}`);
        try {
          db.updateAppScaling(app_id, {
            min_replicas,
            max_replicas,
            autoscale_enabled,
            autoscale_cpu_threshold: cpu_threshold,
            autoscale_mem_threshold: mem_threshold,
          });

          // Update scale daemon config if app is scaled
          const app = db.getApp(app_id);
          if (app && app.hetzner_lb_id) {
            const primaryServer = db.getServer(app.server_id);
            if (primaryServer) {
              const replicas = db.getReplicas(app_id);
              const tokens = await getTokens();
              await hetzner.updateScaleDaemonConfig(
                primaryServer.ipv4,
                {
                  hetzner_token: tokens.hetzner_api_token,
                  apps: [{
                    app_name: app.name,
                    hetzner_lb_id: app.hetzner_lb_id,
                    container_port: app.container_port,
                    min_replicas,
                    max_replicas,
                    cpu_threshold,
                    mem_threshold,
                    cooldown_seconds: app.autoscale_cooldown,
                    replicas: replicas.map((r: any) => {
                      const s = db.getServer(r.server_id);
                      return {
                        server_ip: s?.ipv4 || "",
                        container_name: r.container_name,
                        host_port: r.host_port,
                      };
                    }),
                  }],
                },
                primaryServer.ssh_host_key || undefined
              );
            }
          }

          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("updateScalingPolicy", `Failed:`, msg);
          return { ok: false, error: msg };
        }
      },

      getAppMetrics: async ({ app_id }: { app_id: number }) => {
        log("getAppMetrics", `Collecting metrics for app ${app_id}`);
        await collectMetrics(app_id);
        return db.getReplicas(app_id);
      },

      getResources: async (_params: {}) => {
        log("getResources", "Fetching all resources...");

        // Servers from DB with app/replica counts
        const dbServers = db.getServers();
        const servers = dbServers.map((s: any) => ({
          id: s.id,
          name: s.name,
          hetzner_id: s.hetzner_id,
          ipv4: s.ipv4,
          type: s.type,
          location: s.location,
          status: s.status,
          app_count: db.getApps(s.id).length,
          replica_count: db.getReplicasByServer(s.id).length,
        }));

        // Load balancers from Hetzner API
        let load_balancers: any[] = [];
        try {
          const lbs = await hetzner.hetznerApiPublic("/load_balancers?label_selector=managed_by%3Done-click-deploy&per_page=50");
          load_balancers = (lbs.load_balancers || []).map((lb: any) => ({
            id: String(lb.id),
            name: lb.name,
            ipv4: lb.public_net?.ipv4?.ip || "",
            type: lb.load_balancer_type?.name || "lb11",
            location: lb.location?.name || "",
            app_name: lb.labels?.app || "",
            targets: lb.targets?.length || 0,
          }));
        } catch (err) {
          log("getResources", `Failed to fetch LBs: ${err}`);
        }

        // Volumes from Hetzner API
        let volumes: any[] = [];
        try {
          const vols = await hetzner.hetznerApiPublic("/volumes?label_selector=managed_by%3Done-click-deploy&per_page=50");
          volumes = (vols.volumes || []).map((v: any) => {
            const serverName = v.server ? dbServers.find((s: any) => s.hetzner_id === String(v.server))?.name || `server-${v.server}` : "";
            // Find app by volume_id
            const allApps = db.getApps();
            const app = allApps.find((a: any) => a.volume_id === String(v.id));
            return {
              id: String(v.id),
              name: v.name,
              size: v.size,
              server_name: serverName,
              app_name: app?.name || "",
              location: v.location?.name || "",
              app_id: app?.id || 0,
            };
          });
        } catch (err) {
          log("getResources", `Failed to fetch volumes: ${err}`);
        }

        return { servers, load_balancers, volumes };
      },

      deleteResource: async ({ type, id }: { type: "server" | "load_balancer" | "volume"; id: string }) => {
        log("deleteResource", `Deleting ${type} ${id}`);
        try {
          if (type === "server") {
            const server = db.getServers().find((s: any) => s.hetzner_id === id || String(s.id) === id);
            if (server) {
              const apps = db.getApps(server.id);
              const replicas = db.getReplicasByServer(server.id);
              if (apps.length > 0 || replicas.length > 0) {
                const users = [
                  ...apps.map((a: any) => a.name),
                  ...replicas.map((r: any) => `${r.container_name} (replica)`),
                ];
                return { ok: false, error: `Server is in use by: ${users.join(", ")}` };
              }
              return await destroyServer(server.id);
            }
            // Orphan on Hetzner only
            await hetzner.deleteHetznerServer(id);
            return { ok: true };
          } else if (type === "load_balancer") {
            const apps = db.getApps();
            const using = apps.filter((a: any) => a.hetzner_lb_id === id);
            if (using.length > 0) {
              return { ok: false, error: `Load balancer is in use by: ${using.map((a: any) => a.name).join(", ")}` };
            }
            await hetzner.deleteLoadBalancer(id);
            return { ok: true };
          } else if (type === "volume") {
            const allApps = db.getApps();
            const using = allApps.filter((a: any) => a.volume_id === id);
            if (using.length > 0) {
              return { ok: false, error: `Volume is in use by: ${using.map((a: any) => a.name).join(", ")}` };
            }
            await hetzner.deleteVolume(id);
            return { ok: true };
          }
          return { ok: false, error: "Unknown resource type" };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("deleteResource", `Failed: ${msg}`);
          return { ok: false, error: msg };
        }
      },

      resizeVolume: async ({ volume_id, size }: { volume_id: string; size: number }) => {
        log("resizeVolume", `Resizing volume ${volume_id} to ${size}GB`);
        try {
          await hetzner.resizeVolume(volume_id, size);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("resizeVolume", `Failed: ${msg}`);
          return { ok: false, error: msg };
        }
      },

      attachVolume: async ({ app_id, size, mount_path }: { app_id: number; size: number; mount_path?: string }) => {
        log("attachVolume", `Attaching new ${size}GB volume to app ${app_id}`);
        try {
          const app = db.getApp(app_id);
          if (!app) throw new Error("App not found");
          if (app.volume_id) throw new Error("App already has a volume attached");
          const server = db.getServer(app.server_id);
          if (!server) throw new Error("Server not found");
          const hostKey = server.ssh_host_key || undefined;

          const suffix = Date.now().toString(36).slice(-4);
          const volName = `ocd-${app.name}-${suffix}`;
          const vol = await hetzner.createVolume({
            name: volName,
            size,
            server_id: parseInt(server.hetzner_id, 10),
            location: server.location,
          });

          const hostMountPath = `/mnt/${volName}`;
          const containerPath = mount_path || "/data";
          await hetzner.sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
          const volumeMount = `${hostMountPath}:${containerPath}`;

          db.updateAppVolume(app_id, String(vol.id), volumeMount);

          const result = await recreateAppContainer(app_id, volumeMount);
          if (!result.ok) throw new Error(result.error || "Failed to recreate container");

          log("attachVolume", `Volume ${vol.id} attached to app ${app_id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("attachVolume", `Failed: ${msg}`);
          return { ok: false, error: msg };
        }
      },

      attachExistingVolume: async ({ app_id, volume_id, mount_path }: { app_id: number; volume_id: string; mount_path?: string }) => {
        log("attachExistingVolume", `Attaching existing volume ${volume_id} to app ${app_id}`);
        try {
          const app = db.getApp(app_id);
          if (!app) throw new Error("App not found");
          if (app.volume_id) throw new Error("App already has a volume attached");
          const server = db.getServer(app.server_id);
          if (!server) throw new Error("Server not found");
          const hostKey = server.ssh_host_key || undefined;

          // Verify volume and server are in the same location
          const volInfo = await hetzner.hetznerApi(`/volumes/${volume_id}`);
          const volLocation = volInfo.volume?.location?.name;
          if (volLocation && volLocation !== server.location) {
            throw new Error(`Cannot attach: volume is in ${volLocation} but server is in ${server.location}`);
          }

          await hetzner.attachVolume(volume_id, parseInt(server.hetzner_id, 10));

          const hostMountPath = `/mnt/vol-${volume_id}`;
          const containerPath = mount_path || "/data";
          await hetzner.sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
          const volumeMount = `${hostMountPath}:${containerPath}`;

          db.updateAppVolume(app_id, volume_id, volumeMount);

          const result = await recreateAppContainer(app_id, volumeMount);
          if (!result.ok) throw new Error(result.error || "Failed to recreate container");

          log("attachExistingVolume", `Volume ${volume_id} attached to app ${app_id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("attachExistingVolume", `Failed: ${msg}`);
          return { ok: false, error: msg };
        }
      },

      detachVolume: async ({ app_id }: { app_id: number }) => {
        log("detachVolume", `Detaching volume from app ${app_id}`);
        try {
          const app = db.getApp(app_id);
          if (!app) throw new Error("App not found");
          if (!app.volume_id) throw new Error("App has no volume attached");

          await hetzner.detachVolume(app.volume_id);
          db.updateAppVolume(app_id, "", "");

          const result = await recreateAppContainer(app_id, undefined);
          if (!result.ok) throw new Error(result.error || "Failed to recreate container");

          log("detachVolume", `Volume detached from app ${app_id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("detachVolume", `Failed: ${msg}`);
          return { ok: false, error: msg };
        }
      },

      reattachVolume: async ({ volume_id, from_app_id, to_app_id, mount_path }: { volume_id: string; from_app_id: number; to_app_id: number; mount_path?: string }) => {
        log("reattachVolume", `Moving volume ${volume_id} from app ${from_app_id} to app ${to_app_id}`);
        try {
          const fromApp = db.getApp(from_app_id);
          if (!fromApp) throw new Error("Source app not found");
          const toApp = db.getApp(to_app_id);
          if (!toApp) throw new Error("Target app not found");
          if (toApp.volume_id) throw new Error("Target app already has a volume attached");

          const fromServer = db.getServer(fromApp.server_id);
          const toServer = db.getServer(toApp.server_id);
          if (!fromServer || !toServer) throw new Error("Server not found");
          if (fromServer.location !== toServer.location) {
            throw new Error(`Cannot reattach: volume is in ${fromServer.location} but target server is in ${toServer.location}`);
          }

          // Detach from source
          await hetzner.detachVolume(volume_id);
          db.updateAppVolume(from_app_id, "", "");
          await recreateAppContainer(from_app_id, undefined);

          // Attach to target
          await hetzner.attachVolume(volume_id, parseInt(toServer.hetzner_id, 10));
          const hostMountPath = `/mnt/ocd-${toApp.name}-data`;
          const containerPath = mount_path || "/data";
          const toHostKey = toServer.ssh_host_key || undefined;
          await hetzner.sshExec(toServer.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, toHostKey);
          const volumeMount = `${hostMountPath}:${containerPath}`;
          db.updateAppVolume(to_app_id, volume_id, volumeMount);
          await recreateAppContainer(to_app_id, volumeMount);

          log("reattachVolume", `Volume ${volume_id} moved from app ${from_app_id} to app ${to_app_id}`);
          return { ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("reattachVolume", `Failed: ${msg}`);
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
