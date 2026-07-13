export type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: Array<{ key: string; label: string; generate?: string; default?: string }>;
  editableSecrets?: Array<{ key: string; label: string; generate?: string }>;
  defaultVolumeSize: number;
  icon?: string;
  color?: string;
  http?: boolean;
  stateless?: boolean;
  description?: string;
  category?: string;
  recommendedMemoryMb?: number;
};

export type ManifestEnvDef = {
  key: string;
  description?: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
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
  };
  env?: ManifestEnvDef[];
  volume?: { size?: number; path?: string };
  webhook?: { enabled?: boolean; branch?: string; path?: string; wait_for_ci?: boolean };
  suggested_app_name?: string;
  replicas?: number;
  public?: boolean;
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

export type ParsedManifest = {
  path: string;
  dir: string;
  manifest: DeployManifest;
};

export type IntrospectResult =
  | {
      ok: true;
      owner: string;
      repo: string;
      default_branch: string;
      branches: string[];
      suggested_app_name: string;
      dockerfiles: string[];
      detected_port: number | null;
      env_vars: Array<{ key: string; value: string }>;
      manifests: ParsedManifest[];
      notes: string[];
    }
  | { ok: false; error: string; suggested_app_name?: string };

export type FormState = {
  app_name: string;
  git_repo: string;
  git_branch: string;
  domain: string;
  container_port: string;
  volume_size: string;
  volume_path: string;
  dockerfile_path: string;
  docker_context: string;
  webhook_enabled: boolean;
  webhook_branch: string;
  webhook_path: string;
  webhook_wait_for_ci: boolean;
  auth_password: string;
  replicas: string;
  public: boolean;
  extra_volumes: Array<{ host_path: string; container_path: string }>;
  server_id: string; // "" = auto
  memory_mb: string; // "" / "0" = platform default
  cpu_limit: string; // "" / "0" = platform default; fractional cores allowed
  health_check: boolean; // HTTP probe after deploy; independent of internal_protocol
  internal_protocol: "http" | "tcp"; // internal routing protocol (L7 vs raw TCP)
  sticky: boolean; // sticky sessions on the ingress service
  rate_limit_rps: string; // "" / "0" = unlimited
  ip_allowlist: string; // comma-separated IPs/CIDRs, "" = open
  health_check_path: string; // "" = no active HTTP health check
  compress: boolean; // response compression on the public router
  public_protocol: "off" | "tcp" | "udp"; // "off" = no raw TCP/UDP exposure
  public_port: string; // requested public pool port; "" = auto-assign
};
