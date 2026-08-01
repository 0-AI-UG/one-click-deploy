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
  deleted_at?: string | null;
  purge_after?: string | null;
};

export type AppData = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  source_mode?: string;
  image_ref?: string;
  build_cache_ref?: string;
  status: string;
  container_port: number;
  webhook_enabled: number | boolean;
  webhook_branch?: string;
  webhook_path?: string;
  webhook_wait_for_ci?: number | boolean;
  /** When set, webhook pushes deploy to the <name>-staging sibling and hold for
   *  manual promotion instead of redeploying production. */
  webhook_staging?: number | boolean;
  /** The environment the staging sibling deploys with; null/absent = staging off. */
  webhook_staging_environment_id?: number | null;
  /** App id this app is a staging sibling of; set = it's a hidden sibling. */
  target_of?: number | null;
  desired_replicas: number;
  volume_id?: string | number;
  volume_mount?: string;
  /** Whether HTTP basic auth is enabled (derived server-side from the password
   *  hash). The password itself is write-only and never sent to the client. */
  auth_enabled?: boolean;
  deployed_by_username?: string;
  env_vars?: EnvVarEntry[] | string | Record<string, string>;
  environment_id?: number | null;
  environment_name?: string | null;
  environment_stale?: boolean | number;
  autoscale_enabled?: boolean;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  autoscale_req_threshold?: number;
  scale_to_zero_after?: number;
  sleeping_server_id?: number | null;
  sleeping_host_port?: number | null;
  public?: boolean | number;
  memory_mb?: number;
  cpu_limit?: number;
  internal_port?: number;
  health_check?: boolean | number;
  health_check_mode?: string;
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  internal_protocol?: string; // 'http' | 'tcp'
  sticky?: boolean | number;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean | number;
  public_port?: number | null;
  public_protocol?: string;
  /** `<panel-ip>:<public_port>` when raw TCP/UDP exposed (server-derived). */
  public_address?: string | null;
  config_revision?: number;
  last_manifest_path?: string | null;
  last_manifest_hash?: string | null;
  last_manifest_applied_at?: string | null;
  last_manifest_config_revision?: number | null;
};

export type ReplicaData = {
  id: number;
  container_name: string;
  server_id: number;
  host_port?: number;
  status: string;
  cpu_percent?: number;
  memory_percent?: number;
  cpu_limit_cores?: number;
  memory_used_mb?: number;
  memory_limit_mb?: number;
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
  image_digest?: string;
  git_commit?: string;
  source?: string;
  status: string;
  deploy_log?: string;
  config_revision?: number;
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
  cpu_limit_cores?: number;
  memory_used_mb?: number;
  memory_limit_mb?: number;
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
  cpu_cores: number | null;
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
  retired_state?: string;
  retired_from?: string;
  purge_after?: string;
  retention_class?: "user" | "provisional";
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

export type Stack = {
  id: number;
  name: string;
  status: string;
  deploy_log: string;
  created_at: string;
  environment_id: number | null;
  app_count: number;
  service_count: number;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
  resource_status_reason?: string;
};

export type StackMemberApp = {
  id: number;
  name: string;
  status: string;
  domain?: string | null;
  public?: boolean | number;
  git_repo?: string;
  webhook_enabled?: number | boolean;
  webhook_staging_environment_id?: number | null;
  /** JSON array of member keys this app depends on, as declared by `needs` in
   *  the stack manifest. Drives the level-by-level deploy/promote order. */
  stack_needs?: string | null;
  /** Set on staging siblings — they follow their production app and are not
   *  members in their own right. */
  target_of?: number | null;
  environment_stale?: boolean | number;
};

export type StackMemberService = {
  id: number;
  name: string;
  service_type: string;
  version: string;
  status: string;
};

export type StackDetail = {
  id: number;
  name: string;
  status: string;
  deploy_log: string;
  created_at: string;
  environment_id: number | null;
  staging_environment_id: number | null;
  last_operation_id?: number | null;
  last_operation_status?: string | null;
  last_operation_failed?: boolean;
  operation_in_progress?: boolean;
  resource_status_reason?: string;
  apps: StackMemberApp[];
  services: StackMemberService[];
};

// --- Stack builder (web repo-driven deploy) ---

export type StackEnvDef = {
  key: string;
  description?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
};

export type StackServiceSpec = {
  key: string;
  type: string;
  version?: string;
  volume_size?: number;
  env_overrides?: Record<string, string>;
};

// A fully-resolved app deploy spec (server-built from the repo's manifest),
// editable in the builder and POSTed as one of a stack's apps. Mirrors the
// server's DeployRequest field set (minus environment_id, which the stack owns).
export type StackAppSpec = {
  key: string;
  needs?: string[];
  app_name: string;
  git_repo: string;
  git_branch?: string;
  container_port: number;
  domain?: string;
  public?: boolean;
  env_vars?: Array<{ key: string; value: string; secret?: boolean }>;
  volume_size?: number;
  volume_path?: string;
  dockerfile_path?: string;
  docker_context?: string;
  webhook_enabled?: boolean;
  webhook_branch?: string;
  webhook_path?: string;
  webhook_wait_for_ci?: boolean;
  // Opt-in from the member's own manifest (`webhook.staging`): pushes build a
  // hidden <name>-staging sibling instead of redeploying production directly.
  webhook_staging?: boolean;
  auth_password?: string;
  replicas?: number;
  extra_volumes?: Array<{ host_path: string; container_path: string }>;
  memory_mb?: number;
  cpu_limit?: number;
  health_check?: boolean;
  internal_protocol?: "http" | "tcp";
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean;
  public_port?: number | "auto" | null;
  public_protocol?: "tcp" | "udp";
};

export type StackAppResolved = {
  manifest_path: string;
  env: StackEnvDef[];
  spec: StackAppSpec;
};

export type StackDeployBody = {
  name: string;
  environment_id?: number; // Reuse an existing environment instead of auto-creating one
  // Stack-level shared env (already merged across all members) written into the
  // stack's environment. Members no longer carry per-app env_vars.
  env_vars?: Array<{ key: string; value: string; secret: boolean }>;
  // The stack's one staging environment, shared by every member that opted into
  // webhook staging — not overridable per member. Omit/null and the server
  // auto-creates `<stack>-stack-staging-env` (a copy of the stack environment)
  // as soon as any member opts in.
  staging_environment_id?: number | null;
  services: StackServiceSpec[];
  apps: StackAppSpec[];
};

export type ScopeType = "global" | "environment" | "app";

/** One permission row. `scopeId` is null exactly when scopeType is "global";
 *  otherwise it is an app id or environment id, stringified. */
export type PermissionGrant = {
  permission: string;
  scopeType: ScopeType;
  scopeId: string | null;
};

/** What a client-side permission check is about. */
export type PermissionScope = {
  appId?: number | null;
  environmentId?: number | null;
};

export type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  webauthnEnabled: boolean;
  /** Global permissions only. */
  permissions: string[];
  createdAt: string;
};

/** GET /api/admin/users/:id/permissions */
export type UserPermissionsResponse = {
  grants: PermissionGrant[];
  permissions: string[];
  allPermissions: string[];
  scopablePermissions: string[];
  /** Per-permission scope kinds, mirroring PERMISSION_SCOPES in
   *  shared/db/users.ts. A permission absent from this map is global-only. */
  scopeKinds?: Record<string, Array<"environment" | "app">>;
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
  webhook_staging_environment_id?: number | null;
  /** Staging on with no environment named — the server mints
   *  `<app>-staging-env` as a copy of the app's own environment. */
  webhook_staging?: boolean;
  auth_password?: string;
  replicas?: number;
  public?: boolean;
  extra_volumes?: Array<{ host_path: string; container_path: string }>;
  server_id?: number;
  memory_mb?: number;
  cpu_limit?: number;
  health_check?: boolean;
  internal_protocol?: "http" | "tcp";
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean;
  public_port?: number | "auto";
  public_protocol?: "tcp" | "udp";
};
