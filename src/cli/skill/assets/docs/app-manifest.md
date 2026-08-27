# App Manifest

The default file is `.ocd-deploy.json`. It is the complete desired
configuration for one app. Unknown fields are rejected by default.

## Example

```json
{
  "$schema": 1,
  "name": "API",
  "description": "Public API",
  "suggested_app_name": "api",
  "image": {
    "ref": "ghcr.io/example/api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "container_port": 3000,
  "environment": "production",
  "env": [
    { "key": "DATABASE_URL", "required": true, "secret": true }
  ],
  "domain": "api.example.com",
  "public": true,
  "replicas": 2,
  "health_check": {
    "mode": "http",
    "path": "/health",
    "expected_statuses": [200]
  },
  "volume": null
}
```

`image.ref` is mandatory and must be an immutable
`repository@sha256:<64 hex digest>` reference. `container_port` is a top-level
field; it is not nested under an image or build object. Tags are rejected.

## Complete top-level field reference

| Field | Meaning |
| --- | --- |
| `$schema` | Optional schema version; currently `1`. |
| `$llm` | Optional agent/tooling metadata ignored by the engine. |
| `name` | Required human-readable manifest name. |
| `description` | Optional description metadata. |
| `icon` | Optional icon URL metadata. |
| `image` | Required object containing immutable `image.ref`. |
| `container_port` | Container listener port, default `3000`. |
| `env` | Declared environment inputs and secret metadata. |
| `environment` | Existing environment name; `null` detaches it. |
| `volume` | Required primary-volume intent; use `null` for none. |
| `suggested_app_name` | Name proposed when creating the app. |
| `domain` | Desired custom domain; `""` clears it. |
| `env_projection` | Environment keys exposed to this app; `[]` exposes none. |
| `auth` | Basic-auth intent; plaintext passwords stay outside the manifest. |
| `replicas` | Desired replica count. |
| `autoscaling` | Autoscaling enablement, range, thresholds, and cooldown. |
| `public` | Whether public HTTP ingress is exposed. |
| `extra_volumes` | Additional host-to-container mounts. |
| `memory_mb` | Per-container memory ceiling in MB. |
| `cpu_limit` | Per-container CPU ceiling in cores. |
| `health_check` | HTTP, command, file, container, or periodic readiness policy. |
| `internal_protocol` | `http` or raw `tcp` private routing. |
| `sticky` | Cookie-based public HTTP stickiness. |
| `rate_limit_rps` | Public request limit; `0` disables it. |
| `ip_allowlist` | Comma-separated IP/CIDR allowlist; `""` clears it. |
| `compress` | Public HTTP response compression. |
| `public_port` | Public raw TCP/UDP port, `"auto"`, or `null`. |
| `public_protocol` | `tcp` or `udp`. |
| `durability_class` | `none`, `standard`, or `high`. |
| `placement_pool` | Scheduler pool name. |
| `scale_to_zero_after` | Idle seconds before scale-to-zero; `0` disables delay. |

## Nested fields

- `image.ref`: exact OCI digest reference.
- `env[]`: `key`, optional `description`, `default`, `required`, and `secret`.
- `auth`: required `enabled`, optional `password_env`.
- `volume`: required `size`, optional provider `id` and mount `path`.
- `extra_volumes[]`: `host_path` and `container_path`.
- `health_check`: optional `enabled`, `mode`, `path`, `command`, `file`,
  `max_age_seconds`, and `expected_statuses`.
- `autoscaling`: optional `enabled`, `min_replicas`, `max_replicas`,
  `cpu_threshold`, `memory_threshold`, `requests_per_minute`, and
  `cooldown_seconds`.

HTTP readiness accepts only `expected_statuses`, defaulting to `[200]`. A 404
does not count as ready unless explicitly listed. Non-HTTP modes have their own
required fields: `exec` requires `command`; `heartbeat` and `periodic_job`
require `file` and `max_age_seconds`.

## Replacement and retention

The manifest is complete desired state. `volume` is deliberately required so
a partial manifest cannot silently detach data:

- `null`: no primary volume;
- `{ "size": 20, "path": "/data" }`: create/manage a provider volume;
- `{ "id": "provider-id", "size": 20, "path": "/data" }`: adopt that
  retained provider volume.

Provider volumes grow only; shrinking is rejected. `environment` and `domain`
are retention exceptions: omission retains an existing value, while explicit
`null`/`""` clears it.

## Validation

```text
ocd manifest validate [path]
```

`--allow-unknown` is an explicit version-skew escape hatch. Unknown keys remain
warnings and should be resolved by updating the CLI.
