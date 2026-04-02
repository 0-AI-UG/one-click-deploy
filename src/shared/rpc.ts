import type { RPCSchema } from "electrobun/bun";

export type Server = {
  id: number;
  name: string;
  hetzner_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  created_at: string;
};

export type App = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  git_repo: string;
  dockerfile_path: string;
  container_port: number;
  host_port: number;
  env_vars: string;
  status: string;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  github_webhook_id: string;
  auth_password: string;
  created_at: string;
};

export type DnsRecord = {
  id: number;
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
};

export type DeploymentRecord = {
  id: number;
  app_id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  created_at: string;
};

export type ServerWithApps = Server & { apps: App[] };

export type DeployRequest = {
  app_name: string;
  domain?: string;
  git_repo: string;
  container_port: number;
  env_vars: Record<string, string>;
  server_id?: number;
  server_type?: string;
  server_location?: string;
  volume_size?: number; // GB, if set a Hetzner Volume is created and mounted
  volume_path?: string; // Container mount path, defaults to /data
  dockerfile_path?: string; // Path to Dockerfile in repo, auto-discovered if omitted
  webhook_enabled?: boolean;
  webhook_branch?: string; // Branch to watch, defaults to "main"
  auth_password?: string; // If set, deploys a login gate in front of the app
};

export type Settings = {
  hetzner_api_token: string;
  hetzner_dns_token: string;
  github_pat: string;
  dns_zone_id: string;
  default_server_type: string;
  default_location: string;
};

export type DeployAppRPC = {
  bun: RPCSchema<{
    requests: {
      getServers: {
        params: {};
        response: ServerWithApps[];
      };
      getApps: {
        params: {};
        response: App[];
      };
      getSettings: {
        params: {};
        response: Settings;
      };
      saveSettings: {
        params: Settings;
        response: { ok: boolean };
      };
      deploy: {
        params: DeployRequest;
        response: { ok: boolean; error?: string };
      };
      destroyApp: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
      deleteServer: {
        params: { server_id: number };
        response: { ok: boolean; error?: string };
      };
      refreshServers: {
        params: {};
        response: ServerWithApps[];
      };
      getDeployLog: {
        params: { app_id: number };
        response: string;
      };
      openExternal: {
        params: { url: string };
        response: { ok: boolean };
      };
      // New operations
      restartApp: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
      pauseApp: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
      unpauseApp: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
      redeployApp: {
        params: { app_id: number; env_vars?: Record<string, string>; auth_password?: string | null };
        response: { ok: boolean; error?: string };
      };
      updateAppEnv: {
        params: { app_id: number; env_vars: Record<string, string> };
        response: { ok: boolean; error?: string };
      };
      getContainerLogs: {
        params: { app_id: number; tail?: number };
        response: { logs: string; error?: string };
      };
      getDeployments: {
        params: { app_id: number };
        response: DeploymentRecord[];
      };
      rollbackApp: {
        params: { app_id: number; deployment_id: number };
        response: { ok: boolean; error?: string };
      };
      enableWebhook: {
        params: { app_id: number; branch?: string };
        response: { ok: boolean; error?: string };
      };
      disableWebhook: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      deployProgress: {
        app_name: string;
        step: string;
        detail: string;
      };
    };
  }>;
};
