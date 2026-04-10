export type ProgressFn = (step: string, detail: string) => void;

export interface App {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  dockerfile_path: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
  volume_id: string;
  volume_mount: string;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  github_webhook_id: string;
  auth_password: string;
  deploy_mode: string;
  compose_file: string;
  compose_web_service: string;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  scale_to_zero_after: number;
  last_scale_at: string | null;
  hetzner_lb_id: string;
  deployed_by: string;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  wake_token: string | null;
}

export interface Replica {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  last_health_at: string | null;
  unhealthy_ticks: number;
  created_at: string;
}

export interface Server {
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
}

export function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [scale:${context}]`, ...args);
}
