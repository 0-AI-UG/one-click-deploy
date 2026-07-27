# OCD troubleshooting guide

## Contents

- [First-response checklist](#first-response-checklist)
- [Deployment fails health check](#deployment-fails-health-check)
- [UI setting disappeared](#ui-setting-disappeared)
- [Manifest differs in UI](#manifest-differs-in-ui)
- [Environment is stale](#environment-is-stale)
- [Stack failed or disappeared](#stack-failed-or-disappeared)
- [Webhook did not deploy](#webhook-did-not-deploy)
- [Staging can reach production data](#staging-can-reach-production-data)
- [Private networking fails](#private-networking-fails)
- [Cannot scale](#cannot-scale)
- [Cannot delete environment](#cannot-delete-environment)
- [Destroy reports cleanup failure](#destroy-reports-cleanup-failure)
- [CLI lost contact](#cli-lost-contact)
- [PostgreSQL restore conflicts](#postgresql-restore-conflicts)

## First-response checklist

Collect state without mutating:

```bash
ocd status
ocd apps
ocd stack status <name>      # for stacks
ocd ops --limit 50
ocd ops <id>
ocd ops logs <id>
ocd logs <app> --tail=200
```

Record:

- current app/stack resource status;
- operation ID/kind/status/error and failed step;
- deployed commit and configuration revision;
- whether environment is stale;
- Git branch/commit and manifest path used;
- relevant server/volume/service status.

Do not retry, cancel, or delete until the failed step and current resource state
are understood.

## Deployment fails health check

Check:

1. process listens on `0.0.0.0`, not loopback;
2. `build.container_port` matches the process;
3. `health_check.path` returns success without external dependencies that are
   not ready;
4. raw-TCP/worker apps use `health_check.enabled: false`;
5. raw TCP uses `internal_protocol: "tcp"`;
6. startup completes before the health timeout;
7. required environment values exist.

Inspect container logs and operation build/health steps. Do not disable health
checking for an HTTP service merely to hide a real startup failure.

## UI setting disappeared

Determine which operation ran:

- `ocd redeploy` preserves stored UI configuration;
- `ocd deploy` applies complete manifest/default configuration first;
- stack re-up applies each child manifest;
- `ocd config apply` applies without code.

Run `ocd config diff` against the manifest and inspect last manifest
provenance/config revision. Update the manifest or UI intentionally; do not
alternate accidental ownership.

## Manifest differs in UI

This means current `config_revision` differs from
`last_manifest_config_revision`. Possible causes:

- UI setting edit;
- environment variable edit;
- scaling/storage/ingress operation;
- another API/config apply.

It does not mean running code is unhealthy. Review current config and manifest,
then choose:

- keep UI state and use `ocd redeploy`;
- encode it in Git and `ocd deploy`;
- deliberately revert with `ocd config apply/deploy`.

## Environment is stale

A running container predates a relevant environment edit.

Choose:

```bash
ocd envs set <env> KEY=VALUE                 # default: rebuild/redeploy
ocd envs set <env> KEY=VALUE --restart       # current image, no build
ocd redeploy <app>                           # latest code + stored config
ocd restart <app>                            # current image + current env
```

If a prior edit used `--no-rollout` or limited `--app`, stale status is
expected. Projections mean unrelated keys need not stale every stack member.

## Stack failed or disappeared

Use:

```bash
ocd stack logs <name>
ocd ops --limit 50
```

A failed first deploy may compensate the stack row. `stack logs` falls back to
operation logs. Inspect child operations and identify whether a dependency,
health check, capacity limit, service catalog entry, or env conflict failed.

Fix the cause, then prefer `ocd ops retry <id>` when recovery is supported or
rerun `ocd deploy stack`. Do not recreate manually until compensation/ownership
state is clear.

## Webhook did not deploy

Check:

- webhook enabled and GitHub registration exists;
- panel has a public domain;
- acting user has linked GitHub access;
- signature secret matches;
- pushed branch matches stored branch;
- changed files match normalized path filter;
- CI status did not fail/time out;
- operation/deployment history for source `webhook`;
- staging mode may have deployed a hidden sibling instead of production.

CI waiting polls for up to 30 minutes. A recorded CI failure/timeout skips the
build.

## Staging can reach production data

The staging environment was probably auto-copied from production. Copies include
secrets and service URLs.

Immediately isolate staging, rotate exposed credentials if needed, provision
staging dependencies, replace URLs, and verify the selected staging environment
before another push.

## Private networking fails

Check:

- consumer uses `<app>.ocd.internal` or injected `<KEY>_URL`;
- `internal_protocol` matches the actual protocol;
- TCP consumers include `container_port`; HTTP consumers use portless URL;
- target has running replicas and is healthy;
- fleet private networking/proxy reconciliation completed;
- a user environment value did not override `OCD_INTERNAL_*` incorrectly;
- stack projection includes the dependency URL key.

Never use a public domain for app-to-app traffic when private wiring exists.

## Cannot scale

Common causes:

- attached cloud volume locks max replicas to one;
- durability/placement requires more hosts/locations than available;
- selected placement pool has no eligible ready capacity;
- autoscale min/max values are invalid;
- request-based scaling is unavailable for raw-TCP apps;
- sleeping private app needs an explicit wake.

Inspect server pools, replicas, scaling policy/events, and availability state.

## Cannot delete environment

Deletion is intentionally blocked while apps link it and always needs web UI
approval.

Run `ocd envs show <env>` to list linked apps. Reassign/destroy them explicitly,
verify stack/staging ownership, then rerun deletion and approve it in the UI.
There is no force flag.

## Destroy reports cleanup failure

OCD keeps the app row as `cleanup_failed` when container, DNS, webhook, volume,
or other cleanup fails. Inspect operation steps and provider/current resources.
Fix reachability/provider issues and retry cleanup. Do not delete the DB row
manually; it is the reconciliation target.

## CLI lost contact

The server-side operation may still run. The follower automatically retries
transient outages, but after it gives up:

```bash
ocd ops <id>
ocd ops logs <id> --follow
```

Do not enqueue duplicates solely because the local CLI exited.

## PostgreSQL restore conflicts

Errors such as `schema "pgmq" already exists` commonly mean the managed image
initialized extension schemas before an authoritative dump restore.

Isolate writers, take a backup, then either:

- restore with `--clean --if-exists`; or
- drop/recreate an empty application database and restore there.

Use `--no-owner --no-privileges --exit-on-error`, validate schema/data, then
recreate linked app containers with current credentials.
