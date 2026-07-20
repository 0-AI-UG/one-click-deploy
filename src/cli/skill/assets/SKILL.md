---
name: ocd-deploy
description: Deploy and operate apps on One-Click Deploy (OCD), a self-hosted Hetzner PaaS (like Heroku/Railway/Render). Use when authoring an `.ocd-deploy.json` app manifest or an `ocd-stack.json` multi-app stack, or when running the `ocd` CLI to deploy, redeploy, roll back, scale, view logs, deploy to staging/production targets, promote staging to production, manage environments/managed services (Postgres, Redis, MySQL, ...), or wire several apps and databases together. Trigger on: "deploy this to OCD", ".ocd-deploy.json", "ocd-stack.json", "ocd deploy", "ocd deploy --target", "ocd promote", "ocd stack", "one-click deploy", "deploy to my panel/Hetzner PaaS".
---

# One-Click Deploy (OCD)

One-Click Deploy ("OCD") is a self-hosted, open-source PaaS for Hetzner Cloud —
a lightweight alternative to Heroku, Railway, and Render. Point it at a Git repo
containing a Dockerfile and it provisions a Hetzner server, builds the image,
configures DNS, issues TLS (Traefik + Let's Encrypt), and serves traffic over
HTTPS. It is deeply tied to one provider: Hetzner servers, volumes, private
networks, firewalls, and DNS.

## When to use this skill

Use it whenever you need to:

- Write or edit an **`.ocd-deploy.json`** manifest so a repo deploys with sensible defaults.
- Write or edit an **`ocd-stack.json`** to deploy several apps + managed services together.
- Drive the **`ocd` CLI** — deploy, redeploy, rollback, restart, pause, logs, ssh, envs, services, stacks.
- Decide the right OCD settings for an app (ports, health checks, volumes, scaling, networking, public exposure).

The full field-by-field schema and complete CLI reference are in
[reference.md](reference.md). Copy-pasteable starting points are in
[examples/](examples/). This file is the map; reach for those two when you need
detail.

## Core concepts

- **App** — one deployable unit: a Git repo (or subdir) with a Dockerfile, built and run as one or more containers behind Traefik with automatic HTTPS.
- **Manifest** — `.ocd-deploy.json`, committed to a repo, pre-configures the deploy so a user just clicks "Deploy" (or runs `ocd deploy`) with no manual settings. One per deployable service.
- **Managed service** — one-click Postgres, Redis, MySQL, MongoDB, ClickHouse, and more. Credentials are injected into linked environments.
- **Environment** — a named group of env vars (plain or secret) shared across apps. Changing an environment redeploys its linked apps.
- **Stack** — `ocd-stack.json`: several apps + services deployed together as one ordered, health-gated unit, with credentials and internal URLs wired automatically.
- **Internal networking** — every app is reachable at `<app>.ocd.internal:<port>` on the private network. The platform injects `OCD_INTERNAL_URL/HOST/PORT`; stacks additionally publish each app as `<KEY>_URL`.
- **Health-gated deploys** — a deploy that never passes its health check is automatically rolled back.

## Three ways to deploy

1. **Web panel** — paste a GitHub repo URL; the panel introspects Dockerfiles, `EXPOSE` port, `.env.example`, and any `.ocd-deploy.json`, and pre-fills the form.
2. **`.ocd-deploy.json` manifest** — commit it so deploys need zero manual config.
3. **`ocd` CLI** — deploy the current git checkout from the terminal.

For several apps and services at once, use a **stack** (`ocd-stack.json`) via
`ocd stack up` or the panel's Deploy → Stack tab.

## Decision guide

**One app or a stack?**
- One app (optionally using an existing managed service) → a single `.ocd-deploy.json`, deploy with `ocd deploy`.
- Several apps that must deploy together, in order, sharing credentials/URLs (e.g. api + web + db) → an `ocd-stack.json` referencing each app's manifest, deploy with `ocd stack up`.

**Does the app speak HTTP on its port?**
- Yes → leave `health_check` default, optionally set `health_check.path` to a real endpoint (`/healthz`) for better rollout safety.
- No (worker, queue consumer, raw-TCP database) → set `"health_check": { "enabled": false }`. For raw TCP also set `"internal_protocol": "tcp"`. See [examples/worker/.ocd-deploy.json](examples/worker/.ocd-deploy.json).

**Should it be reachable from the internet?**
- Public website/API → `"public": true` (default) → gets an HTTPS domain.
- Internal-only (backend behind another app) → `"public": false`; reach it via `<app>.ocd.internal` / the stack's `<KEY>_URL`.
- Raw TCP/UDP port (game server, MQTT, exposed DB) → `public_port` (+ `public_protocol`), independent of the HTTP domain.

**Needs to persist data?** Add a `volume` (`size` in GB + mount `path`).

**Needs more/less resources?** `memory_mb` and `cpu_limit` (omit or `0` for platform defaults: 512 MB / 1 core). Scale horizontally with `replicas`.

## Authoring an `.ocd-deploy.json`

Minimum viable manifest:

```json
{
  "$schema": 1,
  "name": "My App",
  "build": { "container_port": 3000 }
}
```

Add `env[]` for configuration, `webhook` for auto-deploy on push, `volume` for
persistence, and `health_check.path` for a real health endpoint. A fuller
single-service example is in
[examples/single-service/.ocd-deploy.json](examples/single-service/.ocd-deploy.json).
Every field is documented in [reference.md](reference.md#the-ocd-deployjson-manifest).

Key rules to get right:
- `name` is the only required field.
- Paths in the manifest are relative to the manifest's directory, **except `build.context`** (relative to repo root). No `..` allowed.
- `env[].key` must match `^[A-Za-z_][A-Za-z0-9_]*$`; mark credentials `secret: true` and must-provide values `required: true`.
- `health_check.path`, `sticky`, and password protection need `internal_protocol: "http"` (the default).

## Authoring an `ocd-stack.json`

A stack references each app's own `.ocd-deploy.json` and adds ordering + wiring.
See [examples/monorepo/ocd-stack.json](examples/monorepo/ocd-stack.json) plus
the two app manifests it references.

```json
{
  "$schema": 1,
  "name": "blog",
  "services": { "database": { "type": "postgresql", "version": "16", "volume_size": 10 } },
  "apps": {
    "api": { "manifest": "services/api/.ocd-deploy.json", "needs": ["database"] },
    "web": { "manifest": "services/web/.ocd-deploy.json", "needs": ["api"], "public": true }
  }
}
```

What the stack does for you:
- **Order**: `needs` builds a dependency graph; services first, then apps in order, each waiting for its dependencies to become **healthy**. Cycles are rejected.
- **Wiring**: one shared environment linked to every member. Each **app** is published as `<KEY>_URL` (uppercased app key), so `web` (needing `api`) automatically gets `API_URL`. Each **service** injects `<KEY>_URL`, `<KEY>_HOST`, `<KEY>_PORT`, `<KEY>_USER`, `<KEY>_PASSWORD`, `<KEY>_NAME` using its **uppercased service key** as the prefix — a service keyed `database` yields `DATABASE_URL` (etc.), one keyed `redis` yields `REDIS_URL`. Pick the service key to match the env-var name your app reads.
- **Reconcile**: re-running `ocd stack up` redeploys listed members and destroys dropped ones.
- **Atomic**: any member failing rolls back the whole run.

Because injected `<KEY>_URL` values only exist after the service/app deploys, **don't list them as `required` in an app's `env[]`** — that makes `ocd stack up` prompt for them up front. Leave connection/URL vars out of the manifest (the container still gets them from the shared env); declare only vars the deployer must supply, like `JWT_SECRET`.

Common mistake: the service `type` must be the **exact catalog key** —
`postgresql` (not `postgres`), `redis`, `mysql`, `mariadb`, `mongodb`,
`clickhouse`, `rabbitmq`, `kafka`, `meilisearch`, `minio`, `qdrant`, `typesense`,
`ollama`. A wrong type fails the deploy with "Unknown service type".

## Driving the `ocd` CLI

Install and log in once:

```bash
curl -fsSL <PANEL_URL>/cli/install.sh | sh
ocd login <PANEL_URL>
```

Everyday commands (full list + flags in
[reference.md](reference.md#the-ocd-cli)):

```bash
ocd deploy                 # deploy the current repo from ./.ocd-deploy.json
ocd stack up               # deploy the whole ocd-stack.json in dependency order
ocd status                 # apps + services overview
ocd logs <app> --tail=200  # recent logs
ocd redeploy <app>         # rebuild + redeploy
ocd rollback <app>         # back to the previous good deploy
ocd ssh <app> -i           # shell inside an app container
ocd envs set <env> KEY=VALUE   # set a var (redeploys linked apps)
```

`ocd deploy` reads the manifest, sends `env[]` defaults, prompts for missing
`required` vars (hidden when `secret`), and streams progress. Override or add
values with repeatable `--set=KEY=VALUE`; link an existing environment with
`--env=<name|id>`. `ocd stack up` does the same across the whole stack, merging
every app's `env[]` into the one shared environment.

### Deploy targets (staging / production)

A **target** is a deploy stage (production / staging / dev) — distinct from an
**environment** (a named env-var bag managed by `ocd envs` and linked with
`--env`). Declare targets in the manifest's `targets` block:

```json
{
  "$schema": 1,
  "name": "My App",
  "build": { "container_port": 3000 },
  "targets": {
    "production": { "branch": "main" },
    "staging": {
      "branch": "develop",
      "replicas": 1,
      "domain": "staging.example.com",
      "scale_to_zero_after": 300,
      "isolated": true
    }
  }
}
```

All per-target fields are optional: `branch`, `replicas`, `domain`,
`scale_to_zero_after`, `isolated` (defaults to `true` for every non-production
target). Deploy a declared target with `--target`:

```bash
ocd deploy                     # = --target=production when declared → bare app <name>, "general" pool
ocd deploy --target=staging    # separate sibling app <name>-staging, "staging" pool
ocd promote staging --yes      # rebuild production at the exact commit staging runs
```

- `--target=production` (or no `--target`, when the manifest declares a
  `production` target) deploys the bare app `<name>`. Without a `targets` block,
  plain `ocd deploy` applies no target semantics at all.
- `--target=staging` deploys a **separate sibling app** `<name>-staging` with its
  **own isolated environment** (seeded by copying production's env vars but **not**
  its service links) and its own "staging" server pool. Because service links are
  not copied, staging never touches the production database — link a DB to the
  staging environment explicitly if it needs one.
- `--target` and `--env` are **mutually exclusive**: a target manages its own
  environment, whereas `--env` links an existing bag. An unknown target name
  errors and lists the declared targets.
- `ocd promote <target>` promotes the exact git commit currently running in the
  staging sibling up to production, rebuilding the production app pinned to that
  commit (reusing the rollback machinery). `ocd promote staging` derives
  source=`<name>-staging`, dest=`<name>` from the manifest; or be explicit with
  `ocd promote --from=<app> --to=<app>`. Pass `--yes` to skip confirmation
  (required in non-interactive contexts).

## Common recipes

- **Node/Go/Python web app** → single manifest, `build.container_port`, `health_check.path`, `webhook.enabled`. See the single-service example.
- **API + SPA in a monorepo** → two manifests under `services/*`, each with its own `webhook.path`; deploy independently or together in a stack.
- **App + database** → a stack with a `postgresql` service the app `needs`; the connection string is injected — don't hardcode it.
- **Background worker** → `public: false` + `health_check.enabled: false`. See the worker example.
- **Raw TCP service (e.g. exposed database, game server)** → `internal_protocol: "tcp"`, `health_check.enabled: false`, and `public_port` if it must be reachable from the internet.

## Pitfalls to avoid

- Don't invent a service type — use the exact catalog keys above (`postgresql`, not `postgres`).
- Don't set `health_check.path` on a non-HTTP app; it'll fail the probe and roll back. Use `health_check.enabled: false` instead.
- Don't put `..` in any manifest path.
- Don't hardcode inter-app URLs or DB credentials in a stack — consume the injected `<KEY>_URL` / service env vars.
- Remember `build.context` is repo-root-relative while every other path is manifest-relative.
