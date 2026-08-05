# Immutable artifacts, build cache, and workload health

## Source modes and deployment identity

OCD supports two mutually exclusive application source modes.

`git` is the default. OCD clones the stored repository and branch, discovers or
uses the stored Dockerfile, builds a fresh local image, and starts containers
from that build. A manual redeploy reads the stored Git/build configuration,
not the local manifest.

`image` runs a prebuilt OCI artifact:

```json
{
  "$schema": 1,
  "name": "Billing worker",
  "suggested_app_name": "billing-worker",
  "image": {
    "ref": "ghcr.io/acme/billing-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "build": { "container_port": 3000 }
}
```

The `@sha256:` digest is mandatory. A mutable tag is not deployment identity
and is rejected. Initial deploy and redeploy pull that exact digest. GHCR pulls
use the deployer's linked GitHub token when available, so private packages must
grant that identity package read access. Image mode does not clone a repository,
does not accept webhook commit SHAs, and cannot configure Dockerfile, context,
or source-build cache.

OCD stores `source_mode` and `image_ref` as desired configuration. Deployment
history stores `image_digest` beside Git commit and configuration revision.
For image deployments the Git commit is recorded as `artifact`; the digest is
the auditable code identity.

## Explicit shared BuildKit cache

Git source builds can opt into registry-backed cache:

```json
{
  "build": {
    "dockerfile": "Dockerfile",
    "context": ".",
    "container_port": 8080,
    "cache_ref": "ghcr.io/acme/build-cache/orders-api:main"
  }
}
```

With `cache_ref`, OCD uses `docker buildx build --load` plus registry
`--cache-from` and `--cache-to` with `mode=max`. This makes cache state explicit
and shareable across build hosts. The same repository is the normal
content-addressed distribution path for multi-host replicas: OCD publishes an
immutable image-ID tag and targets pull only missing layers. Without it, OCD
uses the host-local Docker builder/cache and cannot perform normal multi-host
distribution. The gzip/SCP archive path is emergency-only and must be enabled
explicitly in Admin settings. The registry identity needs pull and push
permission. Build cache configuration is stored desired config and advances
`config_revision`.

Before a source build or emergency transfer, OCD runs bounded OCD-owned garbage
collection and verifies source and destination root-disk capacity. The budget
includes candidate/expanded layers, current and rollback protection, archive
and import workspace, plus a fixed host reserve. A failure is reported during
preflight rather than after the build or SCP retries.

## Readiness is a workload contract

Container process state and workload readiness are distinct. Every health mode
first verifies that Docker reports a stable running process: restarting,
exited/dead, and recent high-restart-loop states fail. It then applies the
selected readiness contract.

| Mode | Ready when | Required fields | Typical workload |
|---|---|---|---|
| `http` | configured path returns HTTP 2xx–4xx | optional `path` | web/API |
| `container` | one authoritative Docker process-state check passes | none | process-only legacy worker |
| `exec` | configured command exits 0 inside container | `command` | queue consumer with dependency/self-test |
| `heartbeat` | marker file mtime is no older than maximum | `file`, `max_age_seconds` | continuously progressing worker |
| `periodic_job` | last-success marker mtime is no older than schedule tolerance | `file`, `max_age_seconds` | cron/scheduled job |

Examples:

```json
{
  "health_check": {
    "mode": "exec",
    "command": "test -f /run/worker-ready && redis-cli -u \"$REDIS_URL\" ping"
  }
}
```

```json
{
  "health_check": {
    "mode": "heartbeat",
    "file": "/run/worker/last-heartbeat",
    "max_age_seconds": 90
  }
}
```

```json
{
  "health_check": {
    "mode": "periodic_job",
    "file": "/run/jobs/last-success",
    "max_age_seconds": 3900
  }
}
```

The application, not OCD, must atomically update marker files after successful
progress. For a periodic job, choose a maximum age greater than the schedule
interval plus realistic runtime and delay. A marker missing, unreadable, or
older than the limit is not ready even if the process remains running.

Deploy, redeploy, scale, wake, rollback, lifecycle checks, and the reconciler
all call the same stored app health contract. App/replica status therefore
means the configured workload is ready, not merely that a PID exists. An SSH
transport failure is inconclusive and does not authoritatively mark the
workload unhealthy.

HTTP mode also drives HTTP ingress health behavior. Exec and marker modes are
container-side engine probes; do not set an HTTP path with them. For backwards
compatibility, omitted `mode` resolves to `http` unless legacy
`enabled: false` selects `container`.

Inspect the contract and deployed identity with:

```bash
ocd app show <app>
ocd app replicas <app>
ocd app deployments <app>
ocd logs <app>
ocd ops logs <operation-id> --follow
```
