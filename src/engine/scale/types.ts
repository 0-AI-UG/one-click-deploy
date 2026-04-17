export type ProgressFn = (step: string, detail: string) => void;

export interface App {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  git_branch: string;
  dockerfile_path: string;
  docker_context: string;
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
  webhook_path: string;
  webhook_wait_for_ci: number;
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
  deployed_by: string;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  wake_token: string | null;
  environment_id: number | null;
  public: number;
  extra_volumes: string;
  org_id: string;
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
  stopped_at: string | null;
  created_at: string;
}

export interface Server {
  id: number;
  name: string;
  provider_id: string;
  provider: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  private_ipv4: string;
  created_at: string;
}

export function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [scale:${context}]`, ...args);
}

/**
 * The address a tenant server's replica containers are bound to — always
 * the server's private IPv4 on the shared `ocd-net` network. Throws if
 * unset so misconfigured servers fail fast at deploy time instead of
 * silently publishing to the public NIC.
 */
export function replicaBindHost(server: { name: string; private_ipv4: string }): string {
  if (!server.private_ipv4) {
    throw new Error(
      `Server ${server.name} has no private_ipv4 — wait for the network reconciler to attach it before deploying`,
    );
  }
  return server.private_ipv4;
}
