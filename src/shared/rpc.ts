export type Server = {
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  private_ipv4: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  created_at: string;
};

export type App = {
  id: number;
  /** Servers this app currently has replicas on (derived). */
  servers: number[];
  name: string;
  domain: string;
  git_repo: string;
  git_branch: string;
  dockerfile_path: string;
  container_port: number;
  /** Host port of the first replica (derived for display continuity). */
  host_port: number;
  env_vars: string;
  status: string;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  webhook_path: string;
  webhook_wait_for_ci: number;
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
  volume_id: string;
  volume_mount: string;
  extra_volumes: string; // JSON array of "host:container" strings
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

export type EnvVarEntry = {
  key: string;
  value: string;
  secret: boolean;
  updated_at: string;
  encrypted_value?: string;
  iv?: string;
};

export type DeployRequest = {
  app_name: string;
  domain?: string;
  git_repo: string;
  git_branch?: string; // Branch to clone/build from, defaults to repo default branch
  container_port: number;
  env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
  environment_id?: number; // Link to an existing environment instead of providing env_vars
  volume_size?: number; // GB, if set a Hetzner Volume is created and mounted
  volume_path?: string; // Container mount path, defaults to /data
  dockerfile_path?: string; // Path to Dockerfile in repo, auto-discovered if omitted
  docker_context?: string; // Docker build context path relative to repo root, defaults to "."
  webhook_enabled?: boolean;
  webhook_branch?: string; // Branch to watch, defaults to "main"
  webhook_path?: string; // Optional path prefix filter; only push events touching files under it trigger redeploy
  webhook_wait_for_ci?: boolean; // Wait for CI checks to pass before deploying
  auth_password?: string; // If set, deploys a login gate in front of the app
  compose_file?: string; // Path to compose file, auto-detected if omitted
  compose_web_service?: string; // Which compose service Caddy proxies to (default: auto-detect)
  replicas?: number; // Number of replicas (default 1, >1 creates LB)
  public?: boolean; // Whether the app is publicly accessible (default true)
  extra_volumes?: Array<{ host_path: string; container_path: string }>; // Additional volume mounts
  server_id?: number; // If set, deploy to this specific server instead of auto-selecting
  memory_mb?: number; // Per-container memory ceiling in MB. Omit / 0 → platform default
  userns?: boolean; // Allow unprivileged user namespaces (bubblewrap etc.). Relaxes seccomp to unconfined.
};

export type PanelInfo = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  git_repo: string;
  git_branch: string;
  container_port: number;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  env_vars: string;
  status: string;
  created_at: string;
};

export type PanelDeployment = {
  id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

export type DeployManifest = {
  $schema?: number;
  $llm?: string;
  name: string;
  description?: string;
  icon?: string;
  build?: {
    dockerfile?: string;
    context?: string;
    container_port?: number;
    compose_file?: string;
    compose_web_service?: string;
  };
  env?: Array<{
    key: string;
    description?: string;
    default?: string;
    required?: boolean;
    secret?: boolean;
  }>;
  volume?: { size?: number; path?: string };
  webhook?: { enabled?: boolean; branch?: string; path?: string; wait_for_ci?: boolean };
  suggested_app_name?: string;
  replicas?: number;
  public?: boolean;
  extra_volumes?: Array<{ host_path: string; container_path: string }>;
  memory_mb?: number; // Per-container memory ceiling in MB. Omit / 0 → platform default
  userns?: boolean; // Allow unprivileged user namespaces (bubblewrap etc.). Relaxes seccomp to unconfined.
};

export type ParsedManifest = {
  path: string;
  dir: string;
  manifest: DeployManifest;
};

export type Settings = {
  provider_token: string;
  dns_zone_id: string;
  default_server_type: string;
  default_location: string;
};
