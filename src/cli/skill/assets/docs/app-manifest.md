# App Manifest

The default file is `.ocd-deploy.json`. It is the complete desired
configuration for one app.

## Example

```json
{
  "suggested_app_name": "api",
  "domain": "api.example.com",
  "git_branch": "main",
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".",
    "container_port": 3000,
    "cache_ref": ""
  },
  "environment": "production",
  "env": [
    {
      "key": "DATABASE_URL",
      "required": true,
      "secret": true
    }
  ],
  "env_projection": null,
  "auth": {
    "enabled": false
  },
  "public": true,
  "memory_mb": 512,
  "cpu_limit": 1,
  "health_check": {
    "mode": "http",
    "path": "/health",
    "expected_statuses": [200]
  },
  "internal_protocol": "http",
  "sticky": false,
  "rate_limit_rps": 0,
  "ip_allowlist": "",
  "compress": false,
  "public_port": null,
  "public_protocol": "tcp",
  "replicas": 2,
  "autoscaling": {
    "enabled": true,
    "min_replicas": 1,
    "max_replicas": 5,
    "cpu_threshold": 80,
    "memory_threshold": 85,
    "requests_per_minute": 0,
    "cooldown_seconds": 300
  },
  "durability_class": "none",
  "placement_pool": "general",
  "scale_to_zero_after": 0,
  "volume": null,
  "extra_volumes": [],
  "webhook": {
    "enabled": true,
    "branch": "main",
    "path": "",
    "wait_for_ci": false,
    "staging": true,
    "staging_environment": "staging"
  }
}
```

Use `image.ref` instead of Git/build source fields for a prebuilt image:

```json
{
  "suggested_app_name": "worker",
  "image": {
    "ref": "ghcr.io/example/worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "volume": null,
  "public": false
}
```

## Manifest-owned fields

- `$schema`: Manifest schema version; currently `1`.
- `$llm`: Optional agent/tooling metadata ignored by the deploy engine.
- `name`: Human-readable manifest name.
- `description`: Human-readable description metadata.
- `icon`: Icon URL metadata.
- `suggested_app_name`: App name used by deploy.
- `domain`: Desired custom domain; `""` clears it.
- `git_branch`: Git branch.
- `image`: Prebuilt image source.
- `build`: Dockerfile, context, container port, and cache reference.
- `environment`: Environment name, or `null` to detach.
- `env`: Declared environment values and secret metadata.
- `env_projection`: Environment projection mode or `null`.
- `auth`: Basic-auth intent; passwords stay outside the manifest.
- `public`: Whether HTTP ingress is exposed.
- `memory_mb`: Memory limit.
- `cpu_limit`: CPU limit.
- `health_check`: HTTP, command, file, or container health policy.
  HTTP readiness accepts only `expected_statuses` (default `[200]`), so a 404
  is never considered ready unless explicitly declared.
- `internal_protocol`: Upstream protocol.
- `sticky`: Sticky sessions.
- `rate_limit_rps`: Request limit; `0` disables it.
- `ip_allowlist`: Allowlist; `""` clears it.
- `compress`: Response compression.
- `public_port`: Public TCP/UDP port or `null`.
- `public_protocol`: `tcp` or `udp`.
- `replicas`: Desired replica count.
- `autoscaling`: Autoscaling enablement, range, thresholds, and cooldown.
- `volume`: Required primary-volume desired state. Use `null` for no volume,
  `{ "size": 20, "path": "/data" }` for an OCD-managed volume, or
  `{ "id": "provider-id", "size": 20, "path": "/data" }` to adopt one
  exact retained/provider volume.
- `extra_volumes`: Additional persistent volumes.
- `durability_class`: Durability policy.
- `placement_pool`: Scheduling pool.
- `scale_to_zero_after`: Idle seconds; `0` disables scale-to-zero.
- `webhook`: Webhook and staging policy.
- `webhook.staging_environment`: Staging environment name or `null`.

## Autoscaling defaults

When omitted, autoscaling is disabled. Threshold defaults are CPU `80`, memory
`85`, requests `0`, and cooldown `300`. Minimum defaults to `1`; maximum is at
least the desired `replicas` value.

## Complete replacement

Omission normally means the documented default. `volume` is intentionally
required: an app must say either `null` or declare the exact desired volume so
a partial or stale manifest cannot silently detach data. `ocd deploy` creates,
adopts, grows, remounts, or detaches-and-retains the volume to match. Provider
volumes are grow-only; reducing `size` is rejected.

The other durable-state exceptions
are `environment` and `domain`: omit them to retain the existing link/domain,
or use an explicit value (`environment: null`, `domain: ""`) to clear one.
