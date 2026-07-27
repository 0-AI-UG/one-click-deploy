# `.ocd-deploy.json` app manifest

## Contents

- [Location and validation](#location-and-validation)
- [Complete field reference](#complete-field-reference)
- [Environment declarations](#environment-declarations)
- [Path resolution](#path-resolution)
- [Cross-field rules](#cross-field-rules)
- [Example](#example)

## Location and validation

Use one `.ocd-deploy.json` per deployable app. It may live anywhere in the Git
repository. Pass a non-default path to `ocd deploy <path>`, or reference it from
an `ocd-stack.json`.

The manifest must be JSON. `$schema`, when present, must be `1`. Top-level
unknown fields produce warnings and are ignored for forward compatibility;
nested manifest objects are validated against their supported fields.

`name` describes the app to humans. The deployed app name is
`suggested_app_name` when present, otherwise the Git repository basename.

## Complete field reference

| Field | Type/default | Exact behavior |
|---|---|---|
| `$schema` | `1`, optional | Manifest schema version. |
| `name` | non-empty string, required | Human-readable manifest name. |
| `description` | string | Metadata for humans/tooling. |
| `icon` | string | Icon URL metadata. |
| `suggested_app_name` | string | DNS-safe deployed name suggestion; otherwise repo basename. |
| `build` | object | Docker build configuration. |
| `build.dockerfile` | string, `Dockerfile` | Path relative to the manifest directory. `..` is forbidden. |
| `build.context` | string, `.` | Docker build context relative to repository root. `..` is forbidden. |
| `build.container_port` | integer `1..65535`, `3000` | Port on which the process listens inside the container. |
| `build.cache_ref` | OCI registry repository/tag | Explicit shared BuildKit cache. OCD uses registry `cache-from` and `cache-to` with `mode=max`. Source builds only. |
| `image` | object | Prebuilt artifact mode. Mutually exclusive with Dockerfile/context/cache source-build settings. |
| `image.ref` | digest-pinned OCI reference | Required form `registry/repository@sha256:<64 hex>`. Tags such as `latest` are rejected. |
| `git_branch` | string | Branch used by manual deploy/redeploy; otherwise repository/provider default behavior. |
| `env` | array | Deployer-supplied variable declarations; see below. |
| `env_projection` | string[] | Restrict a linked environment to these keys. Omit for every key; `[]` for platform variables only. |
| `domain` | string | Custom public domain. CLI `--domain` overrides it for that apply. |
| `public` | boolean, `true` | Enable public-domain routing. Private networking still works when false. |
| `auth` | object | HTTP basic-auth intent. |
| `auth.enabled` | boolean, required in `auth` | Enable or disable basic auth. HTTP routing only. |
| `auth.password_env` | env-var-name string | Local process variable holding the password. Never put the password in the manifest. |
| `health_check` | object | Post-deploy/ingress health behavior. Bare booleans are invalid. |
| `health_check.enabled` | boolean, `true` | When false, only verify that the container remains running. |
| `health_check.path` | string, `/` | HTTP probe path; also enables continuous Traefik rotation checks. |
| `health_check.mode` | `http`, `container`, `exec`, `heartbeat`, or `periodic_job` | Readiness contract. Omitted preserves legacy `enabled/path` behavior. |
| `health_check.command` | non-empty string | Required for `exec`; runs inside the container and exit code 0 means ready. |
| `health_check.file` | safe absolute container path | Required for `heartbeat` and `periodic_job`; marker mtime records last successful progress. |
| `health_check.max_age_seconds` | positive integer | Required with a marker mode; readiness fails when marker age exceeds this value. |
| `internal_protocol` | `http` or `tcp`, `http` | Private routing protocol. Use `tcp` only when the process speaks raw TCP. |
| `sticky` | boolean, `false` | Cookie stickiness on HTTP ingress. |
| `rate_limit_rps` | integer `0..1000000`, `0` | Public per-client request limit; zero disables it. |
| `ip_allowlist` | string, empty | Comma-separated IPs/CIDRs allowed through public ingress. |
| `compress` | boolean, `false` | Enable gzip on public HTTP responses. |
| `public_port` | integer, `"auto"`, `null`, or omitted | Raw public TCP/UDP exposure. `"auto"` allocates from the protocol pool; `null` removes it. |
| `public_protocol` | `tcp` or `udp`, `tcp` | Pool/protocol for `public_port`. |
| `replicas` | positive integer, `1` | Desired replica count before durability floors. |
| `durability_class` | `none`, `standard`, or `high`; `none` | Availability policy that determines replica/spread floors. |
| `placement_pool` | non-empty string, `general` | Server pool eligible to host replicas. |
| `scale_to_zero_after` | non-negative integer, `0` | Idle seconds before scale-to-zero eligibility; zero disables delay-based scale-to-zero. |
| `memory_mb` | `0` or integer `128..32768`, `0` | Per-container memory limit. Zero means platform default, currently 512 MB. |
| `cpu_limit` | `0` or number `0.1..32`, `0` | Per-container CPU limit with at most two decimals. Zero means platform default, currently 1 CPU. |
| `volume` | object | One OCD-managed persistent volume for a new app. |
| `volume.size` | number `>=1` | Volume size in GB. |
| `volume.path` | absolute path, `/data` | Container mount path. |
| `extra_volumes` | array | Existing host bind mounts, not OCD-managed cloud volumes. |
| `extra_volumes[].host_path` | string | Absolute host path. |
| `extra_volumes[].container_path` | string | Absolute container path. |
| `webhook` | object | GitHub push deployment settings. |
| `webhook.enabled` | boolean, `false` | Register/enable push deployment. Requires linked GitHub access and panel domain. |
| `webhook.branch` | string, `main` | Branch accepted by the webhook. |
| `webhook.path` | string, empty | Only accept changes under this normalized path prefix. |
| `webhook.wait_for_ci` | boolean, `false` | Delay deployment until required CI checks succeed. |
| `webhook.staging` | boolean, `false` | Deploy pushes into a staging sibling for manual promotion. Requires `webhook.enabled`. |

## Environment declarations

Each `env[]` element supports:

| Field | Type | Behavior |
|---|---|---|
| `key` | env-var-name string, required | Must match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `description` | string | Prompt/help text. |
| `default` | string | Safe default supplied when the selected environment lacks the key. |
| `required` | boolean | Block/prompt until a value is supplied. |
| `secret` | boolean | Hide interactive input and store the value encrypted. |

Reserved/dangerous process keys and prefixes such as `PATH`, `HOME`,
`DOCKER_`, `LD_`, and `DYLD_` are rejected.

Value precedence during manifest deploy:

1. explicit `--set=KEY=VALUE`;
2. value already stored in the selected/current environment;
3. manifest `default`;
4. interactive prompt for missing `required` values.

Do not declare stack-injected dependency URLs/credentials as required. They are
created during dependency deployment and injected into the shared environment.

## Path resolution

- Resolve the manifest argument from the current working directory.
- Resolve `build.dockerfile` relative to the manifest directory.
- Resolve child manifests relative to `ocd-stack.json`.
- Resolve `build.context` relative to the Git repository root.
- Reject paths containing `..`.

For a manifest at `services/api/.ocd-deploy.json`, `"dockerfile":
"Dockerfile"` means `services/api/Dockerfile`; `"context": "."` still means
the repository root.

## Cross-field rules

- `health_check.path`, basic auth, and `sticky` require
  `internal_protocol: "http"`.
- `exec` requires `command`; `heartbeat` and `periodic_job` require both
  `file` and `max_age_seconds`. Non-HTTP explicit modes cannot set `path`.
- `image.ref` must be immutable by digest. Image mode cannot set
  `build.dockerfile`, `build.context`, or `build.cache_ref`.
- Raw-TCP workers/databases should use `internal_protocol: "tcp"` and normally
  `health_check.enabled: false`.
- A managed persistent volume forces single-replica operation.
- Adding a managed volume to an already existing app through manifest apply is
  refused; attach storage explicitly first.
- Public raw TCP ports are `30000..30049`; UDP ports are `30050..30099`.
- Webhook staging requires webhook deployment to be enabled.
- `public: false` disables public-domain routing but does not disable private
  application networking.

## Example

```json
{
  "$schema": 1,
  "name": "Orders API",
  "suggested_app_name": "orders-api",
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".",
    "container_port": 8080
  },
  "git_branch": "main",
  "public": true,
  "health_check": {
    "enabled": true,
    "path": "/healthz"
  },
  "env": [
    {
      "key": "DATABASE_URL",
      "description": "Production PostgreSQL connection URL",
      "required": true,
      "secret": true
    },
    {
      "key": "NODE_ENV",
      "default": "production"
    }
  ],
  "memory_mb": 1024,
  "cpu_limit": 1,
  "durability_class": "standard",
  "placement_pool": "general",
  "webhook": {
    "enabled": true,
    "branch": "main",
    "wait_for_ci": true
  }
}
```
