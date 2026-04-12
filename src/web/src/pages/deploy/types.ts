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
    compose_file?: string;
    compose_web_service?: string;
  };
  env?: ManifestEnvDef[];
  volume?: { size?: number; path?: string };
  webhook?: { enabled?: boolean; branch?: string; path?: string };
  suggested_app_name?: string;
  replicas?: number;
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
      suggested_app_name: string;
      dockerfiles: string[];
      compose_files: string[];
      compose_services: Array<{ name: string; port: number | null; has_ports: boolean }>;
      suggested_web_service: string | null;
      detected_port: number | null;
      env_vars: Array<{ key: string; value: string }>;
      manifests: ParsedManifest[];
      notes: string[];
    }
  | { ok: false; error: string; suggested_app_name?: string };

export type FormState = {
  app_name: string;
  git_repo: string;
  domain: string;
  container_port: string;
  volume_size: string;
  volume_path: string;
  dockerfile_path: string;
  docker_context: string;
  webhook_enabled: boolean;
  webhook_branch: string;
  webhook_path: string;
  auth_password: string;
  replicas: string;
  compose_file: string;
  compose_web_service: string;
};
