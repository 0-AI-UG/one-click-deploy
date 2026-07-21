# OCD reference — manifests & CLI

Full field-by-field reference for the `.ocd-deploy.json` and `ocd-stack.json`
manifests and the complete `ocd` CLI. The [SKILL.md](SKILL.md) file has the
overview and the decision guidance; this file is the exhaustive lookup.

---

## The `.ocd-deploy.json` manifest

One app = one manifest. File name is exactly `.ocd-deploy.json`. Place it
anywhere in the repo; for a monorepo add one per deployable service (e.g.
`services/api/.ocd-deploy.json`). All paths inside a manifest are relative to
the directory that contains the manifest file, **except** `build.context`,
which is relative to the repo root.

A repo may hold up to 10 manifests; extras are ignored. All fields except
`name` are optional. Unknown top-level fields are ignored for forward
compatibility (nested unknown keys are silently stripped).

### Fields

| Field | Type | Meaning |
|---|---|---|
| `$schema` | `1` | Schema version. Must be `1` or omitted. |
| `name` | string **(required)** | Display name shown in the deploy UI. Must be non-empty. |
| `description` | string | Short description shown when picking a service. |
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
| `webhook.staging` | boolean | Hold each pushed commit in a `<name>-staging` sibling for manual promotion. Requires `--staging-env=<name\|id>` at deploy time to pick the staging environment. Default `false`. |
| `suggested_app_name` | string | Suggested app name (DNS-safe: lowercase, digits, hyphens). |
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
| `public_port` | integer \| `"auto"` | Expose a raw public TCP/UDP port on the panel IP (game servers, databases, MQTT). `"auto"` picks the lowest free pool port. Independent of the HTTP domain. Omit for none. |
| `public_protocol` | `"tcp"` \| `"udp"` | Pool for `public_port`: `tcp` (30000–30049) or `udp` (30050–30099). Default `tcp`. |
| `extra_volumes[]` | array | Extra host→container bind mounts: `{ "host_path": "/abs/host", "container_path": "/abs/container" }`. |

### `env[]` entry

| Field | Type | Meaning |
|---|---|---|
| `key` | string **(required)** | Env-var name. Must match `^[A-Za-z_][A-Za-z0-9_]*$`. Reserved prefixes (`DOCKER_`, `PATH`, `HOME`, `LD_`, `DYLD_`) are blocked. |
| `description` | string | Shown as a hint in the deploy UI. |
| `default` | string | Pre-filled value. Omit for secrets the user must provide. |
| `required` | boolean | If true, deploy is blocked until a value is supplied. |
| `secret` | boolean | If true, the input is masked in the UI and stored encrypted. |

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
| `services.<key>.type` | string **(required)** | Catalog type — the exact catalog key, e.g. `postgresql`, `redis`, `mysql`, `mariadb`, `mongodb`, `clickhouse`, `rabbitmq`, `kafka`, `meilisearch`, `minio`, `qdrant`, `typesense`, `ollama`. **Use `postgresql`, not `postgres`.** |
| `services.<key>.version` | string | Image version/tag. Optional. |
| `services.<key>.volume_size` | number ≥ 1 | Data volume size in GB. Optional. |
| `services.<key>.env_overrides` | object (string→string) | Override generated service env vars. Optional. |
| `apps` | object **(required)** | Map of app key → app. Must be non-empty. |
| `apps.<key>.manifest` | string **(required)** | Path to that app's `.ocd-deploy.json`, relative to `ocd-stack.json`. |
| `apps.<key>.needs` | string[] | Keys of services/apps this app depends on. Every entry must name a declared key. |
| `apps.<key>.domain` | string | Override the app's custom domain. Optional. |
| `apps.<key>.public` | boolean | Override the app manifest's `public`. Optional. |

PostgreSQL image variants are available as `17-pgvector`, `17-postgis`,
`17-pgmq`, and `17-pgvector-postgis-pgmq`. Each variant automatically enables
its bundled extension(s). `POSTGRES_EXTENSIONS` in `env_overrides` can select
or add any other extension already included in the chosen image.

### Semantics

- **Ordering + readiness**: `needs` forms a dependency graph. Services deploy first, then apps in dependency order — an app starts only once everything it needs is deployed **and healthy**. Dependency cycles are rejected.
- **Wiring**: a stack owns one shared environment (auto-created, or an existing one reused via `--env` when the stack is first created). Every member's own `env[]` vars merge into it, and everything flows to every member's container because they all link that one environment:
  - Each **app** publishes its private internal URL as `<KEY>_URL` (uppercased app key). An app with `needs: ["api"]` sees `API_URL` pointing at the `api` app — no DNS or real names needed.
  - Each **service** injects `<KEY>_URL`, `<KEY>_HOST`, `<KEY>_PORT`, `<KEY>_USER`, `<KEY>_PASSWORD`, `<KEY>_NAME` — where `<KEY>` is the **uppercased service key** (`_URL` and `_PASSWORD` are stored as secrets). So a service keyed `database` yields `DATABASE_URL`, `DATABASE_HOST`, …; a service keyed `redis` yields `REDIS_URL`, … Choose the service key to get the env-var name your app expects.
- **Don't redeclare injected vars as `required`**: because the injected `<KEY>_URL` values only land after the service/app deploys, listing them as `required` in an app's `env[]` makes `ocd stack up` prompt for them up front. Leave service-provided connection vars and sibling `<KEY>_URL` vars **out** of the app manifest — the container still receives them from the shared environment at runtime. Declare only vars the deployer must supply (e.g. `JWT_SECRET`).
- **Reconcile**: re-running `ocd stack up` redeploys every app in the manifest and destroys members recorded under the stack but no longer listed.
- **Atomic**: if any member fails, the whole run rolls back — members deployed in that run are destroyed.
- **Capacity**: the fleet has a hard 200-app cap; a stack that would exceed it is rejected before anything deploys.

---

## Internal networking

Every app has a stable private address `<app>.ocd.internal:<internal-port>`
reachable from other apps on the private network (private apps have **only**
this address). Routing is set by `internal_protocol` (`http` L7 routing, or
`tcp` raw pass-through; default `http`). The platform injects into every
container:

- `OCD_INTERNAL_URL` — `http://<app>.ocd.internal:<port>` for HTTP-routed apps, `tcp://…` for TCP-routed ones.
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
curl -fsSL {{PANEL_URL}}/cli/install.sh | sh
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
ocd delete <app>             Delete an app
ocd logs <app> [--tail=N]    Show app logs (default: last 100 lines)
ocd restart <app>            Restart an app's containers
ocd rollback <app>           Roll back to the previous successful deployment
ocd promote                  Promote the webhook-staging sibling's commit to production
ocd pause <app>              Stop an app without deleting it
ocd unpause <app>            Start a paused app again
ocd envs <subcommand>        Manage environments and their variables
ocd services                 List managed services (Postgres, Redis, ...)
ocd stack <up|down|ls|status|logs>   Deploy/manage multi-app stacks (ocd-stack.json)
ocd servers                  List Hetzner servers and the apps on them
ocd ssh <app> <cmd>          Run a command inside an app container
ocd ssh <app> -i             Interactive shell inside an app container
ocd ssh <server> --server    Interactive shell on a server
ocd skill install --agent X  Install this skill for another agent
ocd version                  Print CLI version
```

App and server arguments accept a name or numeric ID.

### `ocd deploy`

```
ocd deploy [manifest] [--domain=<domain>] [--env=<name|id>] [--staging-env=<name|id>] [--set=KEY=VALUE ...]
```

Run from inside a git repo with an `origin` remote. Reads the manifest
(default `./.ocd-deploy.json`) for name, build settings, port, env, webhook,
volume, and scaling, then streams deploy progress until it completes or fails.
`--domain` sets a custom domain.

`--staging-env=<name|id>` enables **webhook staging**: each pushed commit deploys
to the `<name>-staging` sibling (with the given environment) and holds for manual
promotion instead of redeploying production. It requires `webhook.enabled` in the
manifest; the manifest may also declare `"webhook": { "staging": true }`, but the
environment must still be provided with `--staging-env` at deploy time. Select
production's own environment to share it, or an `ocd envs copy` of it to isolate
staging values.

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
```

Promotes the exact git commit currently running in a source (staging) app up to
a destination (production) app by rebuilding the destination pinned to that
commit (reusing the rollback machinery).

- No arguments — promotes the webhook-staging sibling: source = `<name>-staging`,
  destination = `<name>`, where `<name>` comes from the manifest — run from
  inside the repo.
- `--from=<app>` / `--to=<app>` — explicit source and destination apps (name or
  id); both are required together and override the manifest-derived names.
- `--yes`, `-y` — skip the confirmation prompt (required in non-interactive
  shells; otherwise the command refuses to promote).

### `ocd stack`

```
ocd stack up [manifest] [--env=<name|id>] [--set=<app>.KEY=VALUE ...]   Deploy a stack (default: ocd-stack.json)
ocd stack down <name> [--yes]                          Destroy a stack and every member
ocd stack ls                                           List stacks
ocd stack status <name>                                Show a stack's apps and services
ocd stack logs <name>                                  Print a stack's combined deploy log
```

`ocd stack up` reads `ocd-stack.json` and each referenced `.ocd-deploy.json`,
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

### `ocd envs`

```
ocd envs list                                                List all environments
ocd envs show <name|id>                                      Show details and variables
ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE]  Create an environment
ocd envs set <name|id> KEY=VALUE ... [--replace]             Merge (or replace) variables
ocd envs unset <name|id> KEY [KEY...]                        Remove variables
```

`--secret KEY=VALUE` marks a variable secret (encrypted at rest, not
retrievable later). `set` and `unset` automatically redeploy the apps linked to
the environment.
