export type EnvVarEntry = {
  key: string;
  value: string;
  secret: boolean;
  updated_at: string;
};

export type EnvironmentData = {
  id: number;
  name: string;
  env_vars: EnvVarEntry[];
  created_at: string;
};

export type AppData = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  status: string;
  container_port: number;
  webhook_enabled: number | boolean;
  webhook_branch?: string;
  webhook_path?: string;
  webhook_wait_for_ci?: number | boolean;
  desired_replicas: number;
  volume_id?: string | number;
  volume_mount?: string;
  auth_password?: string;
  deployed_by_username?: string;
  env_vars?: EnvVarEntry[] | string | Record<string, string>;
  environment_id?: number | null;
  environment_name?: string | null;
  autoscale_enabled?: boolean;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  scale_to_zero_after?: number;
  sleeping_server_id?: number | null;
  sleeping_host_port?: number | null;
  public?: boolean | number;
  memory_mb?: number;
  internal_port?: number;
  health_check?: boolean | number;
};

export type ReplicaData = {
  id: number;
  container_name: string;
  server_id: number;
  host_port?: number;
  status: string;
  cpu_percent?: number;
  memory_percent?: number;
};

export type MetricSample = {
  replica_id: number;
  cpu_percent: number;
  ts?: string;
};

export type ScalingEvent = {
  id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason?: string;
  created_at: string;
};

export type DeploymentRecord = {
  id: number;
  image_tag?: string;
  git_commit?: string;
  source?: string;
  status: string;
  deploy_log?: string;
  created_at: string;
};

export type ServerData = {
  id: number;
  name: string;
  ipv4: string;
  type?: string;
  location?: string;
  replica_count?: number;
  monthly_eur?: number;
  provider_id?: string | number;
  apps: AppData[];
};

export type ServiceInstance = {
  id: number;
  container_name: string;
  role: string;
  status: string;
  server_id: number;
  server_name?: string;
  host_port: number;
  cpu_percent?: number;
  memory_percent?: number;
};

export type LinkedEnvironment = {
  id: number;
  name: string;
  env_prefix?: string;
};

export type ServiceData = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
  instances?: ServiceInstance[];
  linked_environments: LinkedEnvironment[];
  credentials?: {
    connection_url?: string;
    host?: string;
    port?: number | string;
    internal_host?: string;
    internal_port?: number | string;
    username?: string;
    password?: string;
    database?: string;
    domain?: string;
    url?: string;
    admin_username?: string;
    admin_email?: string;
    admin_password?: string;
    admin_token?: string;
  };
};

export type ResourceServer = {
  id: number;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  replica_count: number;
  monthly_eur?: number;
  provider_id: string;
};

export type ResourceVolume = {
  id: string;
  name: string;
  size: number;
  location: string;
  server_name?: string;
  app_name?: string;
  monthly_eur?: number;
};

export type ServerMetricSample = {
  server_id: number;
  cpu_percent: number;
  memory_percent: number;
  sampled_at: string;
};

export type ResourcesData = {
  servers: ResourceServer[];
  volumes: ResourceVolume[];
  totals?: {
    servers: number;
    volumes: number;
    total: number;
    currency: string;
  };
};

export type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  webauthnEnabled: boolean;
  permissions: string[];
  createdAt: string;
};

export type PanelApp = {
  id: number;
  name: string;
  domain: string;
  status: string;
  git_branch: string;
  volume_mount?: string;
  webhook_enabled: number | boolean;
};

export type DeployBody = {
  app_name: string;
  git_repo: string;
  git_branch?: string;
  domain?: string;
  container_port: number;
  env_vars?: Array<{ key: string; value: string; secret: boolean }>;
  environment_id?: number;
  volume_size?: number;
  volume_path?: string;
  dockerfile_path?: string;
  docker_context?: string;
  webhook_enabled?: boolean;
  webhook_branch?: string;
  webhook_path?: string;
  webhook_wait_for_ci?: boolean;
  auth_password?: string;
  replicas?: number;
  public?: boolean;
  extra_volumes?: Array<{ host_path: string; container_path: string }>;
  server_id?: number;
  memory_mb?: number;
  health_check?: boolean;
};
