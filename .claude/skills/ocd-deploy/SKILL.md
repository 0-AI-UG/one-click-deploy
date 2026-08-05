---
name: ocd-deploy
description: Deploy and operate apps on One-Click Deploy (OCD), a self-hosted Hetzner PaaS. Use when authoring or reviewing `.ocd-deploy.json` app manifests and `ocd-stack.json` multi-app stacks; running the `ocd` CLI for deploys, logs, SSH, environments, managed services, staging promotion, or operation recovery; choosing routing, health checks, volumes, scaling, placement, and secret handling; or diagnosing stale environments, failed stacks, PostgreSQL restores, and retained volumes. Trigger on “deploy to OCD”, “one-click deploy”, `.ocd-deploy.json`, `ocd-stack.json`, `ocd deploy`, `ocd stack`, or an OCD panel/Hetzner PaaS.
---

# Deploy and operate with OCD

OCD is CLI-first. Commit deployment intent to manifests, keep secrets outside
Git, and use the web panel primarily to observe resources and approve
destructive CLI actions.

## Working method

1. Inspect the repo, Dockerfile, exposed port, health endpoint, required runtime
   variables, persistent paths, and Git remote.
2. Choose one app, a standalone managed service, or a stack.
3. Start from the matching file under [examples/](examples/).
4. Read only the relevant section of [reference.md](reference.md) for exact
   fields and flags.
5. Validate assumptions locally, deploy through the CLI, and follow the
   operation until it is terminal.
6. After a mutation, check `ocd status` or `ocd stack status <name>`; do not
   infer health from the last operation alone.

Install and authenticate once:

```bash
curl -fsSL https://ocd.cero-ai.com/cli/install.sh | sh
ocd login https://ocd.cero-ai.com
```

## Choose the deployment shape

- **One app**: commit `.ocd-deploy.json`; run `ocd deploy`.
- **Several dependent apps/services**: commit one app manifest per app plus
  `ocd-stack.json`; run `ocd deploy stack`.
- **Standalone managed service**: inspect `ocd service catalog`, then run
  `ocd service create`.

The referenced app manifest is the canonical full spec inside and outside a
stack. A stack entry adds only dependency wiring, environment projection, and
optional `domain`/`public` overrides.

## Author app manifests

Minimum:

```json
{
  "$schema": 1,
  "name": "My App",
  "build": { "container_port": 3000 }
}
```

Apply these rules:

- Set a real `health_check.path` for HTTP apps. For workers, set
  `"health_check": { "enabled": false }`; also set
  `"internal_protocol": "tcp"` only when the app itself speaks raw TCP.
- Use `"public": false` for internal apps. HTTP apps use
  `http://<app>.ocd.internal`; TCP apps use
  `tcp://<app>.ocd.internal:<container_port>`.
- Declare deployer-supplied variables in `env[]`. Mark credentials
  `secret: true`; mark values with no safe default `required: true`.
- Never commit a basic-auth password. Use `auth.password_env` or the hidden CLI
  prompt.
- Add `volume` only for data that must survive container replacement. A
  volume-backed app cannot scale beyond one replica.
- Use `placement_pool` in committed manifests. Reserve `--server=<id>` for a
  nonportable one-run override.
- Manifest paths are relative to the manifest directory, except
  `build.context`, which is repo-root-relative. Never use `..`.

See [reference.md](reference.md#the-ocd-deployjson-manifest) for all routing,
resource, webhook, durability, placement, volume, and scaling fields.

## Author stacks safely

```json
{
  "$schema": 1,
  "name": "blog",
  "services": {
    "database": { "type": "postgresql", "volume_size": 10 }
  },
  "apps": {
    "api": {
      "manifest": "services/api/.ocd-deploy.json",
      "needs": ["database"],
      "env": ["DATABASE_URL", "JWT_SECRET", "LOG_LEVEL"]
    },
    "web": {
      "manifest": "services/web/.ocd-deploy.json",
      "needs": ["api"],
      "env": ["API_URL", "NODE_ENV"]
    }
  }
}
```

- `needs` controls health-gated order and must be acyclic.
- Service keys define injected names. Key `database` produces
  `DATABASE_URL`, `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`,
  `DATABASE_PASSWORD`, and `DATABASE_NAME`; app key `api` produces `API_URL`.
- Do not declare injected connection/URL keys as `required` in child manifests;
  they do not exist until their dependency deploys.
- Use an app entry’s `env` list to project only selected shared-environment
  keys; omit it for all keys, or use `[]` for platform keys only.
- Re-running a stack reconciles it. Review removed members carefully: resources
  omitted from the manifest are destroyed, while adopted resources and retained
  volumes are protected by recovery ownership checks.
- Catalog types and versions change. Always use `ocd service catalog` rather
  than inventing or relying on a memorized list.

## Operate through the CLI

```bash
ocd deploy [manifest]                         # app manifest
ocd deploy stack [manifest]                   # stack + child manifests
ocd service catalog
ocd service create db --type=postgresql --volume-size=20
ocd status
ocd stack status <name>
ocd logs <app> --tail=200
ocd ssh <app> -i
ocd redeploy <app>
ocd rollback <app>
ocd envs set <env> KEY=VALUE --restart
ocd ops logs <id> --follow
```

Environment mutations default to rebuild/redeploy. Use `--restart` to recreate
from the current image, `--no-rollout` to defer, and repeat `--app=<name|id>` to
limit affected linked apps. Deferred or partial changes are reported as
`stale environment, redeploy required`.

## Webhook staging

Set `"webhook": { "enabled": true, "staging": true }` in each participating app
manifest.

- Standalone: OCD auto-creates `<app>-staging-env` from the app environment.
  Override it with `ocd deploy --staging-env=<name|id>`.
- Stack: opted-in members share one stack staging environment, auto-created
  from the production stack environment. Override with
  `ocd deploy stack --staging-env=<name|id>`; clear with `--staging-env=`.
- Pushes deploy the staging sibling and hold. Promote the exact deployed commit
  with `ocd promote` or `ocd promote stack <name>`.

The copy includes credentials and service URLs. For data isolation, pre-create
a staging environment and staging services, inject their URLs there, then pass
that environment with `--staging-env`.

## Production safety and recovery

- Treat `ocd ops cancel` as destructive: it may compensate created resources.
  Review the exact targets in browser confirmation; use `--yes` only in an
  explicitly authorized automation session.
- Prefer `ocd ops retry <id>` for resumable work. Use
  `ocd ops finalize <id>` only to reconcile and close an irrecoverably stale
  operation; it will not claim success when resources disagree.
- Stack status is resource-derived. A healthy stack may separately report that
  its last operation failed.
- Destroyed managed volumes are detached and retained for recovery rather than
  immediately deleted. They still incur provider charges.
- Automated `--set` and `--secret` values are passed through process arguments
  today. Use ephemeral runners, masked CI variables, and disabled shell tracing;
  there is no stdin/file secret input yet.
- Before PostgreSQL restore, isolate writers and take a fresh backup. Managed
  images may pre-create extension schemas; use a clean restore or recreate an
  empty target as described in
  [reference.md](reference.md#postgresql-restore-and-retained-volumes).

## Frequent mistakes

- Using `postgres` instead of the catalog key `postgresql`.
- Health-checking a worker or raw-TCP process over HTTP.
- Hardcoding stack service credentials or sibling URLs.
- Assuming pause/unpause refreshes container environment; it does not recreate
  the container.
- Treating an operation failure as the current resource state.
