// Public request shape for the `deploy_service` engine op — consumed by the
// HTTP route that enqueues the op and by the op implementation itself.
// The legacy in-process `deployService()` worker has been replaced by
// `src/engine/ops/deploy-service.ts`; only the type remains.

export type ServiceDeployRequest = {
  name: string;
  service_type: string;
  version?: string;
  volume_size?: number;
  env_overrides?: Record<string, string>;
  environment_id?: number;
  env_prefix?: string;
  /** Optional custom domain for HTTP-facing services; falls back to nip.io. */
  domain?: string;
};
