# Stacks and managed services

## Contents

- [Choose stack or standalone service](#choose-stack-or-standalone-service)
- [Stack deployment lifecycle](#stack-deployment-lifecycle)
- [Dependency wiring](#dependency-wiring)
- [Managed-service catalog](#managed-service-catalog)
- [Standalone service creation](#standalone-service-creation)
- [Stack status and logs](#stack-status-and-logs)
- [Reconciliation and failure](#reconciliation-and-failure)
- [PostgreSQL variants](#postgresql-variants)

## Choose stack or standalone service

Use a stack when apps/services form one dependency graph and should share
environment wiring. Use a standalone service when its lifecycle is independent
or it must inject credentials into an existing environment without becoming a
stack member.

Never guess service types or versions. Query:

```bash
ocd service catalog
```

The catalog changes independently of this skill.

## Stack deployment lifecycle

```bash
ocd deploy stack [ocd-stack.json]
```

The CLI:

1. validates the stack manifest;
2. resolves and validates every child app manifest;
3. reads the current Git `origin`;
4. resolves existing/selected production and staging environments;
5. merges env declarations/defaults/explicit sets;
6. sends complete app/service specs with child manifest provenance;
7. follows the durable `deploy_stack` operation.

The engine:

1. validates capacity, names, dependencies, and catalog entries;
2. creates/adopts stack environments;
3. deploys managed services;
4. injects service credentials and app private URLs;
5. applies complete desired configuration to existing apps;
6. creates/redeploys apps in dependency levels;
7. removes recorded members no longer declared;
8. reconciles shared ingress and records stack status.

Equivalent concurrent stack deploy requests attach to the existing operation.

## Dependency wiring

Service key `database` injects:

- `DATABASE_URL`
- `DATABASE_HOST`
- `DATABASE_PORT`
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_NAME`

App key `api` publishes `API_URL`, using its private `OCD_INTERNAL_URL`.

These names come from the **stack member key**, not service type. Choose keys
that match application expectations, or adapt with environment variables.

App `needs` controls order. It does not itself limit variables; use
`apps.<key>.env` projections for visibility.

## Managed-service catalog

`ocd service catalog` returns:

- exact `type`;
- label/description;
- supported versions;
- default version;
- default volume size;
- whether the service is stateless.

Use `postgresql`, not `postgres`. Do not hardcode the catalog in automation;
query and validate the desired entry before deployment.

## Standalone service creation

```bash
ocd service create database \
  --type=postgresql \
  --version=17 \
  --volume-size=20 \
  --env=production \
  --env-prefix=DATABASE
```

Generated credentials enter the selected environment using the prefix.
`--env-prefix` requires `--env`.

Use repeatable `--set=KEY=VALUE` for service image overrides, such as
extension settings supported by the selected catalog image. Use `--domain`
only for services intended to speak HTTP through public ingress.

Standalone services appear in `ocd services` and the dashboard.

## Stack status and logs

```bash
ocd stack ls
ocd stack status <name>
ocd stack logs <name>
```

Stack status is resource-derived and displayed separately from last operation:

- resource status answers whether current members are healthy;
- last operation answers what the most recent saga did;
- `operation_in_progress` indicates ongoing mutation.

If a deploy fails, OCD retains the stack row, environments, and every successful
member as durable reconciliation checkpoints. `stack logs` continues to resolve
the parent operation and its child operations by stack name.

## Reconciliation and failure

Re-running a stack is not a partial add operation. The submitted manifest
defines desired membership:

- missing recorded members are destroyed;
- existing apps are config-applied and redeployed only when their desired state differs;
- existing services are reconciled/reused according to ownership;
- each failed child compensates only its own incomplete side effects;
- successful new and reused resources survive for retry;
- retry skips an app when commit/image digest, configuration revision,
  environment hash, replica count, links, and replica attestations match;
- declared managed-service volumes are reconciled grow-only and provider size
  confirmation is required before the stack becomes ready;
- environments survive every member/stack destruction;
- managed volumes are retained on destroy.

A renamed member key is a remove-plus-create. Review data ownership and injected
variable-name changes before renaming.

The fleet has a hard 200-app cap. A stack exceeding remaining capacity is
rejected before deployment.

## PostgreSQL variants

Catalog availability is authoritative. Common bundled variants may include:

- `17-pgvector`
- `17-postgis`
- `17-pgmq`
- `17-pgvector-postgis-pgmq`

Bundled extensions may initialize schemas before restore. An authoritative
custom-format restore can conflict with those schemas. See
[operations-and-recovery.md](operations-and-recovery.md) for the clean restore
workflow and retained-volume recovery.
