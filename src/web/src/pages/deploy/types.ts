import type { StackServiceSpec, StackAppResolved } from "../../types.ts";

export type CatalogEntry = {
  type: string;
  label: string;
  versions: string[];
  defaultPort: number;
  requiredEnvVars: Array<{ key: string; label: string; generate?: string; default?: string }>;
  defaultVolumeSize: number;
  icon?: string;
  color?: string;
  http?: boolean;
  stateless?: boolean;
  description?: string;
  category?: string;
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
  // Nested so the toggle and its path read as one feature (mirrors the deploy
  // UI and the manifest schema). enabled defaults true; path feeds both the
  // post-deploy probe and Traefik's rotation check.
  health_check?: { enabled?: boolean; path?: string };
  internal_protocol?: "http" | "tcp";
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  compress?: boolean;
  public_port?: number | "auto" | null;
  public_protocol?: "tcp" | "udp";
  // Deploy targets: each declares a sibling deployment of this app. "production"
  // (or no target) keeps the bare name; any other target deploys an isolated
  // `<name>-<target>` sibling on a separate server pool. Mirrors the manifest
  // `targets` block the CLI reads (see src/cli/commands/deploy.ts).
  targets?: Record<string, DeployTarget>;
};

export type DeployTarget = {
  branch?: string;
  replicas?: number;
  domain?: string;
  scale_to_zero_after?: number;
  isolated?: boolean;
};

/**
 * Effective git-branch override for a selected deploy target. Single source of
 * truth for the submit payload AND the deploy summary so the two can't drift.
 * Precedence mirrors the CLI (src/cli/commands/deploy.ts deriveTarget):
 * target.branch || manifest webhook.branch || "main". Returns null when no
 * declared target is selected (the form/introspect branch applies unchanged).
 */
export function targetBranchOverride(
  manifest: DeployManifest | null,
  targetName: string,
): string | null {
  const target = targetName ? manifest?.targets?.[targetName] : undefined;
  if (!target) return null;
  return target.branch || manifest?.webhook?.branch || "main";
}

export type ParsedManifest = {
  path: string;
  dir: string;
  manifest: DeployManifest;
};

// Resolved stack payload embedded in a `kind: "stack"` introspect result.
export type StackPayload = {
  stack_path: string;
  name: string;
  description?: string;
  services: StackServiceSpec[];
  apps: StackAppResolved[];
  notes: string[];
};

// The deploy mode is implicit: repos with an `ocd-stack.json` come back as
// `kind: "stack"`, everything else as `kind: "app"`. The single Deploy page
// picks its flow from this discriminator.
export type IntrospectResult =
  | {
      ok: true;
      kind: "app";
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
  | {
      ok: true;
      kind: "stack";
      owner: string;
      repo: string;
      default_branch: string;
      branches: string[];
      stack: StackPayload;
    }
  | { ok: false; error: string; suggested_app_name?: string };

// The single-app introspect shape — narrowed from the discriminated result for
// the app-only sections (manifest picker, receipt) that read Dockerfile/port/etc.
export type AppIntrospect = Extract<IntrospectResult, { ok: true; kind: "app" }>;

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
