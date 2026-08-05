# OCD reference — manifests & CLI

Full field-by-field reference for the `.ocd-deploy.json` and `ocd-stack.json`
manifests and the complete `ocd` CLI. The [SKILL.md](SKILL.md) file has the
overview and the decision guidance; this file is the exhaustive lookup.

## Contents

- [App manifest](#the-ocd-deployjson-manifest)
- [Stack manifest](#the-ocd-stackjson-manifest-multi-app-stacks)
- [Internal networking](#internal-networking)
- [CLI installation and commands](#the-ocd-cli)
- [Managed services](#ocd-service)
- [App deployment](#ocd-deploy)
- [Staging promotion](#ocd-promote)
- [Stack operations](#ocd-stack)
- [Environment operations](#ocd-envs)
- [Operation recovery](#ocd-ops)
- [PostgreSQL and volume recovery](#postgresql-restore-and-retained-volumes)

---

## The `.ocd-deploy.json` manifest

One app = one manifest. File name is exactly `.ocd-deploy.json`. Place it
anywhere in the repo; for a monorepo add one per deployable service (e.g.
`services/api/.ocd-deploy.json`). All paths inside a manifest are relative to
the directory that contains the manifest file, **except** `build.context`,
which is relative to the repo root.

All fields except `name` are optional. Unknown fields warn and are ignored for
forward compatibility; misspelled known fields therefore do not configure
anything.

### Fields

| Field | Type | Meaning |
|---|---|---|
| `$schema` | `1` | Schema version. Must be `1` or omitted. |
| `name` | string **(required)** | Human-readable manifest name. Must be non-empty. |
| `description` | string | Short description for operators and tooling. |
| `icon` | string | URL to a small logo/icon. |
| `build.dockerfile` | string | Path to the Dockerfile, relative to this manifest's directory. Default `Dockerfile`. |
| `build.context` | string | Docker build context, relative to the **repo root**. Default `"."`. |
| `build.container_port` | number 1–65535 | Port the app listens on inside the container. |
| `env[]` | array | Declared environment variables (see below). |
| `volume.size` | number ≥ 1 | Persistent volume size in GB. |
| `volume.path` | string starting with `/` | Mount path inside the container. |
| `webhook.enabled` | boolean | Auto-deploy on git push. |
| `webhook.branch` | string | Branch to watch. Default: repo default branch. |
| `webhook.path` | string | Only redeploy when files under this path prefix change. |
| `webhook.wait_for_ci` | boolean | Wait for CI checks to pass before deploying. Default `false`. |
| `webhook.staging` | boolean | Hold each pushed commit in a `<name>-staging` sibling for manual promotion. Requires `webhook.enabled`. The staging environment is auto-created if absent — `<app>-staging-env` (a copy of the app's environment) standalone, or the stack's single staging environment in a stack. Override with `--staging-env=<name\|id>`. Default `false`. |
| `suggested_app_name` | string | Suggested app name (DNS-safe: lowercase, digits, hyphens). |
| `domain` | string | Custom public domain. `--domain` overrides it for one CLI run. |
| `git_branch` | string | Branch used for manual deploys and redeploys. |
| `env_projection` | string[] | Limit a linked environment to these keys. Omit for all keys; `[]` for platform-injected keys only. |
| `auth.enabled` | boolean | Enable/disable HTTP basic auth. An enabled manifest prompts securely unless `auth.password_env` is set. |
| `auth.password_env` | string | Name of a local environment variable containing the basic-auth password. The password itself is never committed to the manifest. |
| `replicas` | integer ≥ 1 | Desired replica count. Default `1`. |
| `public` | boolean | Whether the app gets a public HTTPS domain. Default `true`. |
| `memory_mb` | `0` or 128–32768 | Per-container memory ceiling (MB). `0`/omitted → platform default (512). |
| `cpu_limit` | `0` or 0.1–32 | Per-container CPU ceiling (cores, fractional OK). `0`/omitted → platform default (1). |
| `health_check.enabled` | boolean | `false` skips the HTTP probe and only checks the container stays running — use for non-HTTP apps (databases, workers). Default `true`. |
| `health_check.path` | string | Endpoint the post-deploy probe and Traefik's rotation check request, e.g. `/healthz`. Default `/`. Setting it also enables Traefik's continuous check, dropping failing replicas from rotation. Requires `internal_protocol: "http"`. |
| `internal_protocol` | `"http"` \| `"tcp"` | Internal routing: `http` (L7) or `tcp` (raw pass-through). Default `http`. Password protection, sticky sessions, and `health_check.path` require `http`. |
| `sticky` | boolean | Cookie-based sticky sessions on the app's ingress. Requires `internal_protocol: "http"`. Default `false`. |
| `rate_limit_rps` | integer ≥ 0 | Public-domain rate limit in req/s per client IP. `0` = unlimited. Default `0`. |
| `ip_allowlist` | string | Comma-separated IPs/CIDRs allowed to reach the public domain, e.g. `"203.0.113.4, 10.0.0.0/8"`. Empty = open. |
| `compress` | boolean | gzip responses on the public domain. Default `false`. |
| `public_port` | integer \| `"auto"` \| `null` | Expose a raw public TCP/UDP port on the panel IP (game servers, databases, MQTT). `"auto"` picks the lowest free pool port. `null` explicitly removes exposure; omit for none on a new app. Independent of the HTTP domain. |
| `public_protocol` | `"tcp"` \| `"udp"` | Pool for `public_port`: `tcp` (30000–30049) or `udp` (30050–30099). Default `tcp`. |
| `extra_volumes[]` | array | Extra host→container bind mounts: `{ "host_path": "/abs/host", "container_path": "/abs/container" }`. |
| `durability_class` | `"none"` \| `"standard"` \| `"high"` | Availability policy and replica-spread floor. |
| `placement_pool` | string | Scheduler pool this app may run in. Default `general`. |
| `scale_to_zero_after` | non-negative integer | Idle seconds before a deploy target may scale to zero. |

### `env[]` entry

| Field | Type | Meaning |
|---|---|---|
| `key` | string **(required)** | Env-var name. Must match `^[A-Za-z_][A-Za-z0-9_]*$`. Reserved prefixes (`DOCKER_`, `PATH`, `HOME`, `LD_`, `DYLD_`) are blocked. |
| `description` | string | Shown beside the variable when the CLI prompts for a value. |
| `default` | string | Pre-filled value. Omit for secrets the user must provide. |
| `required` | boolean | If true, deploy is blocked until a value is supplied. |
| `secret` | boolean | If true, CLI input is hidden and the value is stored encrypted. |

**Env-var guidance**
- `required: true` for values with no sensible default that the deployer must supply.
- `secret: true` for credentials, API keys, connection strings.
- Provide a `default` for non-sensitive config that works out of the box (e.g. `NODE_ENV=production`).
- Add a `description` so the deployer understands each variable.

### Rules & gotchas

- Paths must not contain `..`.
- A manifest at `services/api/.ocd-deploy.json` with `"dockerfile": "Dockerfile"` resolves the Dockerfile to `services/api/Dockerfile`, but the build **context** defaults to the repo root.
- Deploys are health-gated: an app that never answers its `health_check.path` (default `/`) on the exposed port is rolled back. For non-HTTP apps set `"health_check": { "enabled": false }`.
- `health_check.path`, `sticky`, and password protection all require `internal_protocol: "http"` (the default). A raw-TCP app must set `internal_protocol: "tcp"` and cannot use those features.

---

## The `ocd-stack.json` manifest (multi-app stacks)

A stack deploys several apps and managed services together from one
compose-style manifest, with dependency ordering and credential/URL wiring
handled for you. File name: `ocd-stack.json`, conventionally at the repo root.
It **references** each app's own `.ocd-deploy.json` by path — it does not inline
per-app build/env config.

### Fields

| Field | Type | Meaning |
|---|---|---|
| `$schema` | `1` | Schema version. Must be `1` or omitted. |
| `name` | string **(required)** | Stack name. Every member is named `<name>-<key>` and is fleet-globally unique (stack `blog` + app key `web` → app `blog-web`). |
| `description` | string | Optional. |
| `services` | object | Map of service key → managed service. Optional. |
| `services.<key>.type` | string **(required)** | Exact catalog key, such as `postgresql`, `redis`, or `mysql`. Run `ocd service catalog` for the current authoritative list. **Use `postgresql`, not `postgres`.** |
| `services.<key>.version` | string | Image version/tag. Optional. |
| `services.<key>.volume_size` | number ≥ 1 | Data volume size in GB. Optional. |
| `services.<key>.env_overrides` | object (string→string) | Override generated service env vars. Optional. |
| `services.<key>.domain` | string | Custom domain for an HTTP-facing managed service. Optional. |
| `apps` | object **(required)** | Map of app key → app. Must be non-empty. |
| `apps.<key>.manifest` | string **(required)** | Path to that app's `.ocd-deploy.json`, relative to `ocd-stack.json`. |
| `apps.<key>.needs` | string[] | Keys of services/apps this app depends on. Every entry must name a declared key. |
| `apps.<key>.env` | string[] | Project the shared environment onto this app. Omit for all keys; `[]` gives the app only platform-injected `OCD_INTERNAL_*` values. |
| `apps.<key>.domain` | string | Override the app's custom domain. Optional. |
| `apps.<key>.public` | boolean | Override the app manifest's `public`. Optional. |

The referenced `.ocd-deploy.json` is the canonical full deployment spec for
each app. Stack entries intentionally add only graph/environment wiring plus
`domain` and `public` overrides; all build, routing, resources, auth, volumes,
webhook, durability, placement, and scaling settings come from the child app
manifest with the same behavior as standalone `ocd deploy`.

PostgreSQL image variants are available as `17-pgvector`, `17-postgis`,
`17-pgmq`, and `17-pgvector-postgis-pgmq`. Each variant automatically enables
its bundled extension(s). `POSTGRES_EXTENSIONS` in `env_overrides` can select
or add any other extension already included in the chosen image.

### Semantics

- **Ordering + readiness**: `needs` forms a dependency graph. Services deploy first, then apps in dependency order — an app starts only once everything it needs is deployed **and healthy**. Dependency cycles are rejected.
- **Wiring**: a stack owns one shared environment (auto-created, or an existing one reused via `--env` when the stack is first created). Every member's own manifest `env[]` declarations merge into it. By default every app receives every key; use the stack entry's `env` projection to limit a member:
  - Each **app** publishes its private internal URL as `<KEY>_URL` (uppercased app key). An app with `needs: ["api"]` sees `API_URL` pointing at the `api` app — no DNS or real names needed.
  - Each **service** injects `<KEY>_URL`, `<KEY>_HOST`, `<KEY>_PORT`, `<KEY>_USER`, `<KEY>_PASSWORD`, `<KEY>_NAME` — where `<KEY>` is the **uppercased service key** (`_URL` and `_PASSWORD` are stored as secrets). So a service keyed `database` yields `DATABASE_URL`, `DATABASE_HOST`, …; a service keyed `redis` yields `REDIS_URL`, … Choose the service key to get the env-var name your app expects.
- **Don't redeclare injected vars as `required`**: because the injected `<KEY>_URL` values only land after the service/app deploys, listing them as `required` in an app's `env[]` makes `ocd deploy stack` prompt for them up front. Leave service-provided connection vars and sibling `<KEY>_URL` vars **out** of the app manifest — the container still receives them from the shared environment at runtime. Declare only vars the deployer must supply (e.g. `JWT_SECRET`).
- **Reconcile**: re-running `ocd deploy stack` redeploys every app in the manifest and destroys members recorded under the stack but no longer listed.
- **Atomic**: if any member fails, the run compensates newly created resources. Reused or subsequently adopted resources are protected from stale-operation compensation.
- **Capacity**: the fleet has a hard 200-app cap; a stack that would exceed it is rejected before anything deploys.

`server_id` is intentionally not a manifest field: numeric server IDs are
panel-local and make a committed manifest non-portable. Use `placement_pool`
for declarative scheduling, or `ocd deploy --server=<id>` as a one-run
standalone operational override.

---

## Internal networking

Every app has a stable `<app>.ocd.internal` name reachable from other apps on
the private network. Routing is set by `internal_protocol` (`http` L7 routing,
or `tcp` raw pass-through; default `http`). The platform injects into every
container:

- `OCD_INTERNAL_URL` — `http://<app>.ocd.internal` for HTTP-routed apps, or
  `tcp://<app>.ocd.internal:<container_port>` for TCP-routed apps.
- `OCD_INTERNAL_HOST`, `OCD_INTERNAL_PORT`.

A user-defined env var with the same key takes precedence. Inside a stack you
usually don't touch these directly — you consume the `<KEY>_URL` vars the stack
wires for you.

---

## The `ocd` CLI

`ocd` is a single-binary CLI (Linux, macOS, Windows) for driving a One-Click
Deploy panel from the terminal.

### Install

```bash
curl -fsSL https://ocd.cero-ai.com/cli/install.sh | sh
```

Detects OS/arch, installs `ocd` to `~/.local/bin` (or `/usr/local/bin` as
root), and pre-fills the panel URL. Binaries are also served at
`/cli/<binary>` (`ocd-linux-x64`, `ocd-linux-arm64`, `ocd-darwin-x64`,
`ocd-darwin-arm64`, `ocd-windows-x64.exe`).

### Authentication

```bash
ocd login <panel-url>   # e.g. ocd login https://panel.example.com
```

Browser device flow: the CLI prints a short code and opens the panel's
authorization page; approve it there and the token is stored in
`~/.config/ocd/config.json` (or `$XDG_CONFIG_HOME/ocd/config.json`). Running
`ocd login` with no argument reuses the saved panel URL.

### Commands

```
ocd login <panel-url>        Log in to a panel (browser device flow)
ocd status                   Dashboard overview: apps and services with statuses
ocd apps                     List all apps (name, status, domain, repo)
ocd deploy [manifest]        Deploy the current git repo using .ocd-deploy.json
ocd redeploy <app>           Rebuild and redeploy an existing app
ocd delete <app> [--yes]     Delete an app (browser confirmation by default)
ocd logs <app> [--tail=N]    Show app logs (default: last 100 lines)
ocd restart <app>            Restart an app's containers
ocd rollback <app>           Roll back to the previous successful deployment
ocd promote                  Promote the webhook-staging sibling's commit to production
ocd pause <app>              Stop an app without deleting it
ocd unpause <app>            Start a paused app again
ocd envs <subcommand>        Manage environments and their variables
ocd ops <subcommand>         Inspect, cancel, retry, or finalize engine operations
ocd services                 List managed services (Postgres, Redis, ...)
ocd service catalog          List catalog types, default versions and volumes
ocd service create <name> --type=<type> [options]  Create a managed service
ocd deploy stack [manifest] Deploy a multi-app stack
ocd delete stack <name>     Destroy a stack and its declared members
ocd stack <ls|status|logs>  Inspect multi-app stacks
ocd servers                  List Hetzner servers and the apps on them
ocd ssh <app> <cmd>          Run a command inside an app container
ocd ssh <app> -i             Interactive shell inside an app container
ocd ssh <server> --server    Interactive shell on a server
ocd skill install --agent X  Install this skill for another agent
ocd version                  Print CLI version
```

### `ocd service`

```
ocd service catalog
ocd service create <name> --type=<type> [--version=<tag>] [--volume-size=<gb>]
                   [--set=KEY=VALUE ...] [--env=<name|id>]
                   [--env-prefix=<prefix>] [--domain=<domain>]
```

`catalog` is the source of truth for supported types, versions, and default
volumes. `create` exposes the same type, version, volume, environment overrides
and HTTP-domain fields as a stack service. With `--env`, generated credentials
are injected into that environment; `--env-prefix` selects their key prefix.

App and server arguments accept a name or numeric ID.

### `ocd deploy`

```
ocd deploy [manifest] [--domain=<domain>] [--env=<name|id>]
           [--staging-env=<name|id>] [--auth-password-env=<key>]
           [--server=<id>] [--set=KEY=VALUE ...]
```

Run from inside a git repo with an `origin` remote. Reads the manifest
(default `./.ocd-deploy.json`) for name, build settings, port, env, webhook,
volume, and scaling, then streams deploy progress until it completes or fails.
`--domain` overrides the manifest domain. `--auth-password-env` overrides
`auth.password_env` without exposing a password in argv or the manifest.
`--server` is a deliberately non-portable one-run placement override.

**Webhook staging** holds each pushed commit in the `<name>-staging` sibling for
manual promotion instead of redeploying production. Turn it on with
`"webhook": { "enabled": true, "staging": true }` in the manifest — staging
always requires `webhook.enabled`, since it holds *pushed* commits.

Naming the environment is optional. With no `--staging-env`, the deploy mints
`<app>-staging-env` as a copy of the app's own environment (an app with no
environment gets an empty one) — the same bargain the app's production
environment gets when `--env` is omitted, and the same one a stack makes for its
members. Pass `--staging-env=<name|id>` to point the sibling at an existing
environment instead — production's own to share it outright, or an
`ocd envs copy` of it you then edit.

The copy includes credentials and service URLs. If staging must not access
production data, prepare it before the first deployment:

```bash
ocd envs copy <production-env> <staging-env>
ocd service create <staging-db> --type=postgresql \
  --env=<staging-env> --env-prefix=DATABASE
ocd deploy stack --staging-env=<staging-env>
```

Repeat service creation for other stateful dependencies, using the prefix the
app expects. This replaces copied production connection values before a
staging container starts.

Env vars from the manifest's `env[]` are included automatically: entries with a
`default` are sent as-is, `--set=KEY=VALUE` (repeatable) overrides or adds
values, and `required` vars still missing a value are prompted for
interactively (hidden input when `secret`). In non-interactive shells, missing
required vars fail the deploy with a message listing them; provide them via
`--set`. `--env` links the app to an existing environment: the manifest's env
vars are then layered on top of it — a value already present in the environment
wins (manifest default skipped), keys the environment lacks are added, and
`--set` overrides everything.

### `ocd promote`

```
ocd promote [--yes]
ocd promote --from=<app> --to=<app> [--yes]
ocd promote stack <name> [--yes]
```

Promotes the exact git commit currently running in a source (staging) app up to
a destination (production) app by rebuilding the destination pinned to that
commit (reusing the rollback machinery).

- No arguments — promotes the webhook-staging sibling: source = `<name>-staging`,
  destination = `<name>`, where `<name>` comes from the manifest — run from
  inside the repo.
- `--from=<app>` / `--to=<app>` — explicit source and destination apps (name or
  id); both are required together and override the manifest-derived names.
- `stack <name>` — promotes every ready staging sibling in dependency order.
  Independent members in the same dependency level may promote concurrently.
- `--yes`, `-y` — skip the confirmation prompt (required in non-interactive
  shells; otherwise the command refuses to promote).

### `ocd stack`

```
ocd deploy stack [manifest] [--env=<name|id>] [--staging-env=<name|id>] [--set=KEY=VALUE ...] [--set=<app>.KEY=VALUE ...]   Deploy a stack (default: ocd-stack.json)
ocd delete stack <name> [--yes]                          Destroy a stack and every member
ocd stack ls                                           List stacks
ocd stack status <name>                                Show a stack's apps and services
ocd stack logs <name>                                  Print a stack's combined deploy log
```

`ocd deploy stack` reads `ocd-stack.json` and each referenced `.ocd-deploy.json`,
then deploys the whole stack in dependency order and streams progress. Run it
from inside the git repo whose `origin` remote holds the apps. Re-running
reconciles: apps in the manifest are redeployed, members dropped from the
manifest are destroyed.

Because every member shares one environment, env vars from all apps' `env[]`
merge into that single shared environment:

- Where only one app declares a key (or only one supplies a non-empty default), that value is used.
- Where several apps declare the same key with **different** defaults, the deploy is refused — unless a `--set` or existing env var resolves it.
- `--set=KEY=VALUE` (and `--set=<app>.KEY=VALUE`, which also targets the shared key) overrides everything; `--env=<name|id>` reuses an existing environment whose values win over manifest defaults (`--set` still overrides). Precedence: `--set` > existing env var > manifest default.
- `required` vars still missing a value after merging are prompted for once.

`--env` is only honored when the stack is first created; later re-ups keep the environment the stack already owns.

#### Webhook staging in a stack

Staging is **opt-in per member**: a member joins staging by setting
`"webhook": { "enabled": true, "staging": true }` in its **own**
`.ocd-deploy.json`. The stack manifest declares nothing about staging.

A stack has exactly **one** staging environment, shared by every opted-in member
— the same shape as its one production environment. It cannot be overridden per
member.

- **Auto-created.** When at least one member opts into staging and the stack has
  no staging environment yet, the deploy creates `<stack>-stack-staging-env` as a
  copy of the stack's production environment (secrets included), mirroring how
  `<stack>-stack-env` is auto-created for production. So `--staging-env` is
  optional — nothing fails for want of it. Tweak the copy afterwards with
  `ocd envs set` to give staging its own values.
- `--staging-env=<name|id>` — use an **existing** environment as the stack's
  staging environment instead of the auto-created one. Every opted-in member
  deploys its `<name>-staging` sibling with it. It is remembered on the stack, so
  re-ups don't need the flag again.
- `--staging-env=` (empty value) — explicitly clear the stack's staging
  environment. (If a member still opts into staging, the next deploy auto-creates
  one again.)

`ocd promote stack <name>` promotes ready staging siblings dependency level by
dependency level (see `ocd promote`).

### `ocd envs`

```
ocd envs list                                                List all environments
ocd envs show <name|id>                                      Show details and variables
ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE]  Create an environment
ocd envs copy <name|id> <new-name>                           Duplicate an environment, including secrets
ocd envs set <name|id> KEY=VALUE ... [--replace] [rollout]   Merge (or replace) variables
ocd envs unset <name|id> KEY [KEY...] [rollout]              Remove variables
ocd envs remove <name|id> [--yes]                            Delete an unused environment
```

`--secret KEY=VALUE` marks a variable secret (encrypted at rest, not
retrievable later). `set` and `unset` default to rebuilding affected linked
apps. Use `--rollout=restart` (or `--restart`) to recreate containers from the
existing image, `--rollout=none` (or `--no-rollout`) to defer application, and
repeat `--app=<name|id>` to limit the rollout. Stack members with an `env`
projection are affected only when a key they consume changed.

Both `--set` and `--secret` values are passed through process arguments today.
For automation, use an ephemeral runner, expand values from masked CI
variables, disable shell tracing, and avoid shared hosts. OCD does not yet
accept secret values through stdin or a file.

### `ocd ops`

```
ocd ops [--app <name>] [--limit N]                 List recent operations
ocd ops <id>                                       Show durable steps and commit SHA
ocd ops logs <id> [--follow]                       Stream operation/build logs
ocd ops cancel <id>                                Request cancellation
ocd ops retry <id>                                 Resume recovery or enqueue a retry
ocd ops finalize <id> [--status auto|done|failed]  Reconcile and close a stale operation
```

`finalize` refuses to mark an operation successful unless its current resources
match the intended successful state. Destructive CLI actions use browser
confirmation by default; `--yes` is the explicit non-interactive approval for
an already-authorized automation session.

`cancel` is potentially destructive because it runs compensation for resources
created by that operation. The browser confirmation shows the operation and
compensation targets; inspect them before approving. Ownership checks prevent
an old operation from deleting resources reused or adopted by later successful
work.

Use `retry` when work can be resumed or safely replayed. Use `finalize` when an
operation is irrecoverably stale and current resources should determine its
terminal result. `ocd stack status` reports resource-derived health separately
from the last operation result.

---

## PostgreSQL restore and retained volumes

Managed PostgreSQL images may initialize bundled extensions before a restore.
A custom-format archive containing the same schemas can then fail with errors
such as `schema "pgmq" already exists`. Isolate application writers and take a
fresh backup before either workflow.

Clean an existing target when the dump is authoritative:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --exit-on-error --dbname="$DATABASE_URL" backup.dump
```

For a full recovery, prefer an empty target: connect through the administrative
`postgres` database, terminate target sessions, drop and recreate the
application database, then run `pg_restore --no-owner --no-privileges
--exit-on-error`. Keep apps isolated until schema and data checks pass. Redeploy
linked apps afterward so their containers receive current service credentials.

Prefer an authorized linked-app shell so the connection URL stays in the
container environment instead of local shell history:

```bash
ocd ssh <linked-app> -i
```

If that image contains `pg_dump`, a custom-format backup can be streamed
without printing the URL:

```bash
ocd ssh <linked-app> 'pg_dump "$DATABASE_URL" --format=custom' > backup.dump
```

Verify the file and checksum. For restore, use a controlled shell or container
with `pg_restore`, transfer the archive securely, and keep writers stopped
until validation is complete.

Managed app and service volumes are detached and registered as retained when
their owner is destroyed or a stateful deployment compensates. The retention
record has a seven-day review date; it is not automatic deletion. Retained
volumes remain billable. Recover an app volume through the panel’s
attach-existing-volume action. Delete a detached provider volume only after
backups and recovery are no longer needed.
