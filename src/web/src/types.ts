export type AppData = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  status: string;
  deploy_mode: string;
  container_port: number;
  webhook_enabled: number | boolean;
  webhook_branch?: string;
  webhook_path?: string;
  desired_replicas: number;
  volume_id?: string | number;
  volume_mount?: string;
  auth_password?: string;
  deployed_by_username?: string;
  env_vars?: string | Record<string, string>;
  autoscale_enabled?: boolean;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  scale_to_zero_after?: number;
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
  hetzner_id?: string | number;
  apps: AppData[];
};

export type ServiceInstance = {
  id: number;
  container_name: string;
  role: string;
  status: string;
  cpu_percent?: number;
  memory_percent?: number;
};

export type LinkedApp = {
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
  instance_count: number;
  instances?: ServiceInstance[];
  linked_apps: LinkedApp[];
  credentials?: {
    connection_url?: string;
    host?: string;
    port?: number | string;
    internal_host?: string;
    internal_port?: number | string;
    username?: string;
    password?: string;
    database?: string;
  };
};

export type ResourceServer = {
  id: number;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  replica_count: number;
  monthly_eur?: number;
  hetzner_id: string;
};

export type ResourceLoadBalancer = {
  id: string;
  name: string;
  ipv4: string;
  type: string;
  location: string;
  app_name?: string;
  targets: number;
  monthly_eur?: number;
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

export type ResourcesData = {
  servers: ResourceServer[];
  load_balancers: ResourceLoadBalancer[];
  volumes: ResourceVolume[];
  totals?: {
    servers: number;
    load_balancers: number;
    volumes: number;
    total: number;
    currency: string;
  };
};

export type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  totpEnabled: boolean;
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

export type TotpStatus = {
  enabled: boolean;
  webauthnEnabled?: boolean;
  backupCodesRemaining?: number;
};

export type DeployBody = {
  app_name: string;
  git_repo: string;
  domain?: string;
  container_port: number;
  env_vars?: Record<string, string>;
  volume_size?: number;
  volume_path?: string;
  dockerfile_path?: string;
  webhook_enabled?: boolean;
  webhook_branch?: string;
  webhook_path?: string;
  auth_password?: string;
  replicas?: number;
  compose_file?: string;
  compose_web_service?: string;
};
