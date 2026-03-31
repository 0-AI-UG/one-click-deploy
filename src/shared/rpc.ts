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
  env_vars: string;
  status: string;
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
};

export type Settings = {
  hetzner_api_token: string;
  hetzner_dns_token: string;
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
