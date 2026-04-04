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
  deploy_mode: string; // "dockerfile" | "compose"
  compose_file: string;
  compose_web_service: string;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  last_scale_at: string;
  hetzner_lb_id: string;
  volume_id: string;
  volume_mount: string;
  created_at: string;
};

export type Replica = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  last_health_at: string;
  created_at: string;
};

export type ScalingEvent = {
  id: number;
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason: string;
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
  compose_file?: string; // Path to compose file, auto-detected if omitted
  compose_web_service?: string; // Which compose service Caddy proxies to (default: auto-detect)
  replicas?: number; // Number of replicas (default 1, >1 creates LB)
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
      scaleApp: {
        params: { app_id: number; replicas: number };
        response: { ok: boolean; error?: string };
      };
      getReplicas: {
        params: { app_id: number };
        response: Replica[];
      };
      getScalingEvents: {
        params: { app_id: number };
        response: ScalingEvent[];
      };
      updateScalingPolicy: {
        params: {
          app_id: number;
          min_replicas: number;
          max_replicas: number;
          autoscale_enabled: boolean;
          cpu_threshold: number;
          mem_threshold: number;
        };
        response: { ok: boolean; error?: string };
      };
      getAppMetrics: {
        params: { app_id: number };
        response: Replica[];
      };
      getResources: {
        params: {};
        response: {
          servers: Array<{
            id: number;
            name: string;
            hetzner_id: string;
            ipv4: string;
            type: string;
            location: string;
            status: string;
            app_count: number;
            replica_count: number;
          }>;
          load_balancers: Array<{
            id: string;
            name: string;
            ipv4: string;
            type: string;
            location: string;
            app_name: string;
            targets: number;
          }>;
          volumes: Array<{
            id: string;
            name: string;
            size: number;
            server_name: string;
            app_name: string;
            location: string;
            app_id: number;
          }>;
        };
      };
      deleteResource: {
        params: { type: "server" | "load_balancer" | "volume"; id: string };
        response: { ok: boolean; error?: string };
      };
      resizeVolume: {
        params: { volume_id: string; size: number };
        response: { ok: boolean; error?: string };
      };
      attachVolume: {
        params: { app_id: number; size: number; mount_path?: string };
        response: { ok: boolean; error?: string };
      };
      attachExistingVolume: {
        params: { app_id: number; volume_id: string; mount_path?: string };
        response: { ok: boolean; error?: string };
      };
      detachVolume: {
        params: { app_id: number };
        response: { ok: boolean; error?: string };
      };
      reattachVolume: {
        params: { volume_id: string; from_app_id: number; to_app_id: number; mount_path?: string };
        response: { ok: boolean; error?: string };
      };
      selfDeploy: {
        params: { domain?: string; server_id?: number; server_type?: string; server_location?: string };
        response: { ok: boolean; url?: string; error?: string };
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
