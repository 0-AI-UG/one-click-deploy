export type Server = {
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  private_ipv4: string;
  provider: "hetzner" | "external";
  ownership: "managed" | "connected";
  management_address: string;
  ssh_user: string;
  ssh_port: number;
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
  container_port: number;
  /** Host port of the first replica (derived for display continuity). */
  host_port: number;
  env_vars: string;
  status: string;
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
  /** Complete manifest reconciliation. Browser/API patches are not supported. */
  apply_mode?: "manifest";
  app_name: string;
  /** Internal manifest provenance for build-source attachment cleanup. */
  delivery_source?: "build" | "image";
  /** OCD-owned BuildKit delivery. API routes replace this with an exact
   * image_ref before entering the runtime deploy/redeploy operations. */
  build?: {
    repository: string;
    branch?: string;
    dockerfile: string;
    context: string;
    image_repository: string;
    platform?: "linux/amd64";
    cache?: boolean;
    webhook?: boolean;
  };
  domain?: string;
  container_port: number;
  env_vars?: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>;
  /** Portable manifest selector. Resolved server-side when environment_id is omitted. */
  environment?: string | null;
  environment_id?: number | null; // Link to an existing environment; null explicitly detaches
  /** Limit this app to selected keys from its linked environment. null/omit =
   *  all keys (legacy); [] = platform OCD_INTERNAL_* variables only. */
  env_projection?: string[] | null;
  volume_id?: string; // Explicit provider volume to adopt; empty = OCD-managed or none
  volume_size?: number; // Desired GB; 0 = explicitly no primary volume
  volume_path?: string; // Container mount path, defaults to /data
  auth_password?: string; // If set, the ingress enforces HTTP basic auth (username "admin"). Requires internal_protocol 'http' (the default)
  replicas?: number; // Number of replicas (default 1, >1 creates LB)
  autoscale_enabled?: boolean;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_req_threshold?: number;
  autoscale_cooldown?: number;
  public?: boolean; // Whether the app is publicly accessible (default true)
  extra_volumes?: Array<{ host_path: string; container_path: string }>; // Additional volume mounts
  server_id?: number; // If set, deploy to this specific server instead of auto-selecting
  /** Internal authorization set only by a server route after browser approval.
   * Client-supplied values are ignored and overwritten. */
  server_provisioning_approved?: boolean;
  memory_mb?: number; // Per-container memory ceiling in MB. Omit / 0 → platform default
  cpu_limit?: number; // Per-container CPU ceiling in cores (fractional allowed). Omit / 0 → platform default
  command?: string[]; // Optional argv appended after the OCI image
  cap_add?: string[]; // Explicit Linux capabilities restored after cap-drop=ALL
  post_start_command?: string; // Idempotent command executed after a healthy rollout
  health_check?: boolean; // Default true; false = skip the HTTP probe, only verify the container is running
  health_check_mode?: "http" | "container" | "exec" | "heartbeat" | "periodic_job";
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  health_check_expected_statuses?: number[];
  /** Immutable prebuilt OCI image. Production artifact deployments require
   * an @sha256 digest; tags are never accepted as deploy identity. */
  image_ref?: string;
  /** Optional source provenance supplied by external CI. Never fetched by OCD. */
  git_commit?: string;
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
  /** Client-computed provenance for an explicitly applied manifest. These are
   * metadata only; the normalized fields above remain the desired spec. */
  manifest_path?: string;
  manifest_hash?: string;
  /** Owning stack control file, populated for stack members. */
  stack_manifest_path?: string | null;
};

export type ReleaseRequest = {
  image: string;
  /** Optional source revision for audit/provenance only. */
  commit?: string;
};

export type PromoteRequest = {
  source_app: string; // app name to promote FROM (e.g. "myapp-staging")
  dest_app: string; // app name to promote TO (e.g. "myapp")
};

export type AppStagingResponse = {
  /** Whether an explicit staging target exists. */
  staging_enabled: boolean;
  /** The staging target's environment, or null when absent. */
  staging_environment_id: number | null;
  /** Git commit of production's most recent successful deployment, or null. */
  prod_commit: string | null;
  /** The explicit <name>-staging target, once deployed. */
  sibling: { id: number; name: string; status: string; domain: string; commit: string | null } | null;
};

export type PanelInfo = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  image_ref: string;
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
  /** Canonical repository-relative owning stack manifest. */
  stack_manifest_path?: string;
  /** Optional partial reconcile selection. Omission means every member. */
  selected_app_keys?: string[];
  /** Partial runs never interpret omitted members as desired removals. */
  partial?: boolean;
  /** Apply desired configuration without changing the released artifact. */
  config_only?: boolean;
  environment_id?: number; // Reuse an existing environment instead of auto-creating one (only honored when the stack is first created)
  /** The stack's explicit shared staging environment. Omit to retain the
   * current selection; null explicitly clears it. */
  staging_environment_id?: number | null;
  env_vars?: Array<{ key: string; value: string; secret?: boolean }>; // Already-merged member env (manifest defaults + --set), written into the shared environment
  /** Staging-only desired values, applied after a staging environment is
   * created/copied so they replace inherited production values. */
  staging_env_vars?: Array<{ key: string; value: string; secret?: boolean }>;
  /** Declared staging contract keys. The server retains certification only for
   * previously-applied keys still present in this list. */
  staging_env_keys?: string[];
  /** Stack members resolved to immutable artifacts before runtime deployment. */
  apps: Array<Omit<DeployRequest, "environment_id"> & {
    key: string;
    needs?: string[];
    /** Client preflight hint. The server promotes this mode when an
     * authoritative config diff requires a more disruptive action. */
    reconcile_mode?: "control" | "runtime" | "artifact";
    /** Stack-only projection intent. `declared` is the safe default for a new
     * member; existing members preserve their stored projection for backwards
     * compatibility until env/env_all is explicit. */
    env_projection_mode?: "declared" | "explicit" | "all";
    /** Child-manifest declarations, used for least-privilege derivation and
     * public-app exposure warnings. Values never appear here. */
    declared_env_keys?: string[];
    /** Generic dependency outputs published as `<MEMBER>_<KEY>` into the
     * shared environment after this member becomes healthy. */
    exports?: Record<string, { value: string; secret?: boolean }>;
  }>;
  /** Internal authorization set only by the stack route after browser approval. */
  server_provisioning_approved?: boolean;
};

export type ParsedManifest = {
  path: string;
  dir: string;
  manifest: DeployManifest;
};

export type Settings = {
  hetzner_api_token: string;
  default_domain_suffix: string;
  default_server_type: string;
  default_location: string;
};
