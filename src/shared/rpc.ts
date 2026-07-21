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
  webhook_branch: string;
  webhook_path: string;
  webhook_wait_for_ci: number;
  github_webhook_id: string;
  /** Whether HTTP basic auth is on (derived from the password hash server-side).
   *  The password and its hash are secrets and never leave the server. */
  auth_enabled: boolean;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  autoscale_req_threshold: number; // target req/min per replica for HTTP request-based scaling; 0 = off
  last_scale_at: string;
  volume_id: string;
  volume_mount: string;
  extra_volumes: string; // JSON array of "host:container" strings
  health_check: number; // 1 = HTTP probe (default); 0 = only verify the container is running
  internal_protocol: string; // 'http' | 'tcp' — internal routing protocol (independent of health_check)
  sticky: number; // 1 = sticky sessions (cookie-based) on the app's ingress service
  rate_limit_rps: number; // public-router rate limit in req/s; 0 = unlimited
  ip_allowlist: string; // comma-separated IPs/CIDRs gating the public router; "" = open
  health_check_path: string; // active HTTP health-check path; "" = off
  compress: number; // 1 = response compression on the public router
  public_port: number | null; // public raw TCP/UDP port on the panel IP; null = not exposed
  public_protocol: string; // 'tcp' | 'udp'
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
  webhook_staging_environment_id?: number | null; // Environment the webhook staging sibling deploys with. Set = enable staging (pushes hold in <name>-staging for manual promotion). Requires webhook_enabled.
  /** The manifest's staging opt-in (`webhook.staging`) with no environment named.
   *  The deploy op then mints `<app>-staging-env` as a copy of the app's own
   *  environment — so the manifest field is self-sufficient, exactly as it is
   *  for a stack member. Ignored when webhook_staging_environment_id is set. */
  webhook_staging?: boolean;
  auth_password?: string; // If set, the ingress enforces HTTP basic auth (username "admin"). Requires internal_protocol 'http' (the default)
  replicas?: number; // Number of replicas (default 1, >1 creates LB)
  public?: boolean; // Whether the app is publicly accessible (default true)
  extra_volumes?: Array<{ host_path: string; container_path: string }>; // Additional volume mounts
  server_id?: number; // If set, deploy to this specific server instead of auto-selecting
  memory_mb?: number; // Per-container memory ceiling in MB. Omit / 0 → platform default
  cpu_limit?: number; // Per-container CPU ceiling in cores (fractional allowed). Omit / 0 → platform default
  health_check?: boolean; // Default true; false = skip the HTTP probe, only verify the container is running
  internal_protocol?: "http" | "tcp"; // Internal routing protocol (independent of health_check); omit → "http". Raw-TCP apps must set "tcp".
  sticky?: boolean; // Sticky sessions (cookie-based) on the app's ingress service
  rate_limit_rps?: number; // Public-router rate limit in req/s; omit / 0 = unlimited
  ip_allowlist?: string; // Comma-separated IPs/CIDRs gating the public router; omit / "" = open
  health_check_path?: string; // Active HTTP health-check path (e.g. /healthz); omit / "" = off. Requires health_check !== false
  compress?: boolean; // Response compression on the public router
  public_port?: number | "auto" | null; // Public raw TCP/UDP exposure: "auto" = lowest free pool port, number = specific pool port, omit = none
  public_protocol?: "tcp" | "udp"; // Pool for public_port (default "tcp"): 30000-30049 tcp, 30050-30099 udp
  placement_pool?: string; // servers.pool this app's replicas may be placed on; omit / "general" = default pool
  target?: string; // deploy target tag: "" | "production" | "staging" | "dev"
  target_of?: number; // app id this is a staging/dev target of; omit = standalone
  /** @deprecated Legacy wire name for `target` (pre-rename clients). Honored only when `target` is absent. */
  env_label?: string;
  /** @deprecated Legacy wire name for `target_of` (pre-rename clients). Honored only when `target_of` is absent. */
  sibling_of?: number;
  durability_class?: "none" | "standard" | "high"; // availability policy, mapped to placement-spread + min-replica floors at insert
  scale_to_zero_after?: number; // idle seconds before scaling to zero (deploy-target override); omit = leave default
};

export type PromoteRequest = {
  source_app: string; // app name to promote FROM (e.g. "myapp-staging")
  dest_app: string; // app name to promote TO (e.g. "myapp")
};

export type AppStagingResponse = {
  /** Whether webhook staging is on (an environment is selected). */
  staging_enabled: boolean;
  /** The environment the staging sibling deploys with, or null when off. */
  staging_environment_id: number | null;
  /** Git commit of production's most recent successful deployment, or null. */
  prod_commit: string | null;
  /** The auto-managed <name>-staging sibling, once it has been deployed. */
  sibling: { id: number; name: string; status: string; domain: string; commit: string | null } | null;
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

// The manifest shapes are DERIVED (via `z.infer`) from the canonical Zod
// schemas in `./manifest-schema.ts` — re-exported here so existing importers of
// these types from `./rpc.ts` keep working. See that file for the per-field
// documentation. This keeps the manifest type and its validator from drifting
// (the drift that once let `"health_check": false` slip past the types).
import type { DeployManifest, StackManifest } from "./manifest-validate.ts";
export type { DeployManifest, StackManifest };

export type StackDeployRequest = {
  name: string;
  environment_id?: number; // Reuse an existing environment instead of auto-creating one (only honored when the stack is first created)
  /** The stack's SHARED staging environment (`--staging-env=<name|id>`) — the
   *  exact same model as `environment_id` above: one per stack, used by every
   *  member that opts into webhook staging, and NOT overridable per member.
   *  Omit to keep what the stack already has (auto-created as a copy of the
   *  stack env on first use); null explicitly clears it. */
  staging_environment_id?: number | null;
  env_vars?: Array<{ key: string; value: string; secret?: boolean }>; // Already-merged member env (manifest defaults + --set), written into the shared environment
  services: Array<{ key: string; type: string; version?: string; volume_size?: number;
                    env_overrides?: Record<string, string>; needs?: string[] }>;
  /** Members. `webhook_staging` is the member manifest's opt-in intent
   *  (webhook.staging) — the ONLY staging input a member has. The environment
   *  is the stack's; any inherited `webhook_staging_environment_id` on an
   *  element is ignored (deploy_stack overwrites it with the resolved value),
   *  exactly as members cannot override `environment_id` either. */
  apps: Array<Omit<DeployRequest, "environment_id"> & {
    key: string;
    needs?: string[];
    webhook_staging?: boolean;
  }>;
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
