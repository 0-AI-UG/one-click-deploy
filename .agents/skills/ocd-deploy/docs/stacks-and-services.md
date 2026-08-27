# Stacks and Managed Services

## Choose stack or standalone service

Use a stack when apps/services share a dependency graph and environment
wiring. Use a standalone service when its lifecycle is independent. Query the
live catalog instead of guessing types or versions:

```bash
ocd service catalog
```

## Stack deployment

```bash
ocd manifest validate ocd-stack.json
ocd deploy stack ocd-stack.json
```

The CLI validates each child manifest, including its exact image digest,
resolves environments and secret inputs, then follows the durable stack
operation. The engine deploys managed services, injects dependency variables,
and rolls out app members in dependency levels. It never builds app images.

Re-running a stack reconciles complete membership. Missing recorded members
are destroyed, successful members are retained as checkpoints after failure,
and managed volumes are grow-only and retained on destroy. A renamed member is
a remove-plus-create.

Use `ocd deploy stack --config-only` to apply stack/member configuration while
retaining currently deployed digests. Use `ocd release` per fully qualified
app name for normal CI image delivery.

## Dependency wiring

Service key `database` injects `DATABASE_URL`, `DATABASE_HOST`,
`DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, and `DATABASE_NAME`.
App key `api` publishes `API_URL` using its private `OCD_INTERNAL_URL`.

Names derive from the member key, not service type. `needs` controls ordering;
`apps.<key>.env` controls which shared variables a member receives.

## Standalone service creation

```bash
ocd service create database \
  --type=postgresql \
  --version=17 \
  --volume-size=20 \
  --env=production \
  --env-prefix=DATABASE
```

`--env-prefix` requires `--env`. Use repeatable `--set=KEY=VALUE` only for
catalog-supported image overrides. Use `--domain` only for HTTP services; OCD
will display any DNS record the operator must create manually.

Managed services and provider volumes require managed Hetzner capacity.
Connected external hosts currently support stateless app containers only.

## Status and logs

```bash
ocd stack ls
ocd stack status <name>
ocd stack logs <name>
```

Resource status describes current health; last-operation status describes the
latest reconciliation. Failed stacks retain successful checkpoints for retry.

## PostgreSQL variants

Catalog output is authoritative. Common variants may include `17-pgvector`,
`17-postgis`, `17-pgmq`, and combinations. Extension images may initialize
schemas before restore; follow the clean target workflow in
[Operations and recovery](operations-and-recovery.md).
