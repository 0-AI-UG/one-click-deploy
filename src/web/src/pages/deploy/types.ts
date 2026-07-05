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
};
