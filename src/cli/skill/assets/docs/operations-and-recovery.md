# Engine operations, compensation, and recovery

## Contents

- [Durable operation model](#durable-operation-model)
- [Statuses](#statuses)
- [Inspect and follow](#inspect-and-follow)
- [Cancellation](#cancellation)
- [Retry](#retry)
- [Finalize](#finalize)
- [Ownership-safe compensation](#ownership-safe-compensation)
- [App/stack cleanup failure](#appstack-cleanup-failure)
- [PostgreSQL restore](#postgresql-restore)
- [Volume recovery](#volume-recovery)
- [Database consolidation and backups](#database-consolidation-and-backups)
- [Panel backups and recovery](#panel-backups-and-recovery)
- [Panel email alerts](#panel-email-alerts)
- [Host disk pressure](#host-disk-pressure)

## Durable operation model

Mutating OCD actions enqueue durable operations. Each operation has:

- kind/label and resource lock keys;
- input, trigger, actor, parent, and retry attempt;
- ordered forward steps;
- persisted step outputs used for resume/probes;
- child operations for fan-out;
- compensation steps for rollback;
- append-only operation logs;
- terminal error/status.

Operations continue server-side if the CLI disconnects. CLI followers print
the operation ID immediately, fall back from event long-polling to detail
polling, show the last step/timestamp, and retry a continuous outage for about
30 minutes with capped backoff. Losing the follower does not prove the
operation stopped.

## Statuses

Common statuses:

- `pending`: queued/waiting for resources;
- `running`: executing forward steps;
- `compensating`: running rollback steps;
- `done`: successful terminal result;
- `failed`: failed without successful compensation conclusion;
- `compensated`: forward work failed/cancelled and rollback completed;
- `compensation_failed`: cleanup itself failed;
- `cancelled`: terminal cancellation state.

Only `done` is CLI success.

## Inspect and follow

```bash
ocd ops [--app <needle>] [--limit N]
ocd ops engine
ocd ops <id>
ocd ops logs <id> [--since N] [--follow]
```

Use detail to inspect:

- current/terminal status and error;
- resource targets and trigger;
- exact forward/rollback steps;
- children;
- deployed commit found in step output.

`ops engine` shows engine heartbeat, concurrency, and registered operation
kinds.

Use log follow during long rollouts or recovery. A numeric `--since` is the
operation-log cursor, not a timestamp.

## Cancellation

```bash
ocd ops cancel <id>
```

Cancellation is cooperative:

- requested at the current/next step boundary;
- may enter compensation;
- can remove resources created by the operation;
- requires browser approval by default;
- cannot be bypassed by a non-interactive CLI flag.

Do not cancel merely because CLI output paused. Inspect operation status/logs
first.

## Retry

```bash
ocd ops retry <id>
```

Retry either resumes recoverable cleanup/work or enqueues a fresh attempt,
depending on operation state. The command returns the operation ID and whether
it resumed. Follow the returned ID.

For a failed stack deployment, retry is a checkpointed continuation: successful
members are retained and convergence skips them, while failed/unreconciled
members continue from the dependency level that still needs work.

Prefer retry when steps are idempotent/resumable and the external cause has
been fixed: capacity, registry access, provider/API availability, health
endpoint, or invalid dependent state.

## Finalize

```bash
ocd ops finalize <id>
ocd ops finalize <id> --status=auto
ocd ops finalize <id> --status=done
ocd ops finalize <id> --status=failed
```

Finalize is for irrecoverably stale operations, not ordinary failures.
The server assesses current resources and refuses to claim success when they do
not match the intended successful result.

- `auto`: choose the justified result from current state;
- `done`: request success, still subject to assessment;
- `failed`: close as failure.

Record the returned assessment in incident notes.

## Ownership-safe compensation

Compensation acts only on side effects the operation created and still owns.
Idempotency keys and probes allow resumed operations to adopt prior side
effects. Reused/adopted resources survive stale compensation.

Stack failure commonly:

- compensates newly created child apps that did not reach a durable checkpoint;
- removes newly created stack rows/environments when they were solely
  provisional deploy side effects;
- preserves resources that existed before the attempt;
- preserves resources adopted by later successful work.

This provisional-deploy rollback is distinct from explicit app/stack deletion.
Explicit deletion never deletes linked environments.

Before stateful apps are deployed, stack deployment validates every app request
and child manifest. Build members are checked out and published by OCD;
prebuilt-image members are resolved to immutable digests before rollout.

## App/stack cleanup failure

App destruction uses best-effort cleanup for containers, volume detach,
ingress, and empty-server GC. If upstream cleanup fails, OCD does not
blindly erase database rows; it marks the app `cleanup_failed` so the reconciler
and operator retain a target for recovery.

For a failed stack first deploy whose stack row was compensated, use:

```bash
ocd stack logs <name>
ocd ops [--limit 50]
```

The stack log command falls back to matching operation history.

## PostgreSQL restore

Before restore:

1. isolate application writers;
2. take and verify a fresh backup/checksum;
3. identify whether bundled image extensions pre-created schemas;
4. keep the target isolated until schema/data validation completes.

For an authoritative custom-format dump into an existing target:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --exit-on-error --dbname="$DATABASE_URL" backup.dump
```

For full recovery, prefer an empty target: connect through administrative
`postgres`, terminate target sessions, drop/recreate the application database,
then restore with `--no-owner --no-privileges --exit-on-error`.

Use an authorized linked-app shell so the URL remains inside the container:

```bash
ocd ssh <linked-app> -i
```

After validation, recreate/redeploy linked apps so they use current credentials.

## Volume recovery

Destroyed app volumes are detached and retained as user-owned data.
Provider block volumes remain billable; local directories occupy their host
disk without a separate storage charge. Their seven-day review date is not
automatic deletion. Use provider Volumes for block disks and Server → Storage
for retained local directories.

Volumes created only by a failed deployment are retained as provisional for
the same seven-day recovery window. After that date, the reconciler permanently
deletes them only when no app or panel references the volume and the
provider reports it detached. Automated deletion is written to the permanent
volume audit. Adopting the volume before expiry removes it from provisional
retention.

Recovery:

1. identify the retained provider volume and former owner;
2. verify backups and filesystem/application consistency;
3. set that app manifest's `volume` to `{ "id": "<provider-id>", "size": <gb>, "path": "/data" }` and run `ocd deploy`;
4. verify mount path and ownership;
5. restart/redeploy and validate;
6. delete only after recovery is no longer required.

## Database consolidation and backups

Preserve the requested storage type, extensions, role isolation, and app
connection settings. Rehearse into isolated databases, stop writers for the final
copy, and compare schema/table counts and data before cutover. Update committed
stack manifests so a later reconciliation does not recreate retired databases.
Retire migration jobs after verification; removing apps retains their storage.
Delete old disks only within the user's authorized cleanup scope after checking
exact provider IDs, detached state, ownership, and verified recovery material.

The OCD repository’s `services/postgres-backup` application runs TypeScript on Bun with
PostgreSQL dump tools every six hours. It encrypts archives, uploads through
scoped OCD storage access, downloads and checks SHA-256, and only then publishes
completion. Dumps are consistent per database, not one transaction across the
cluster. Role passwords are excluded and need independently recoverable secrets;
keep the backup encryption key outside the database. Restore into isolation and
verify extension versions and data before retiring recovery disks. Uploaded
checksums alone are not proof that a restore works. This app's backups have no
automatic historical deletion; panel-backup retention is a different feature.

## Panel backups and recovery

**Admin → Panel** protects OCD's SQLite state, SSH files, and credential/JWT
secret, not application databases, app volumes, images, or DNS. Select a named
S3 connection, existing bucket and prefix, create/download the recovery key,
and keep the key and independent storage credentials outside the panel.
Daily backups default to seven retained successes; uploads are downloaded and
checksum-verified before completion and retention. **Back up now** is available
without enabling the schedule. The current size limits are 256 MiB for SQLite
and 512 MiB for the archive.

Restore with the matching OCD release, stopping the original panel and engine
first. Run the restore command from the matching OCD release checkout. Supply
`OCD_RECOVERY_KEY` and, for S3, `OCD_S3_ENDPOINT`, `OCD_S3_REGION`,
`OCD_S3_ACCESS_KEY`, and `OCD_S3_SECRET_KEY` through the environment:

```bash
bun run restore:panel --from s3://bucket/prefix/backup.ocdb --data-dir /srv/ocd-restored
# Or use a previously downloaded encrypted archive:
bun run restore:panel --file /safe/backup.ocdb --data-dir /srv/ocd-restored
```

The destination must not exist. Restore authenticates and validates the archive
and SQLite before installing it. It preserves recorded hosts and panel placement;
it does not provision infrastructure or migrate the panel. Mount the restored
directory as the matching panel's data directory. Omit `JWT_SECRET` to load the
recovered secret, or supply the identical original value.

Automation starts paused. In **Admin → Panel**, confirm the original panel is
stopped, review saved operations, and use **Verify servers and resume**. OCD
checks pinned host keys and Docker access; this does not prove application data
consistency or that old pending operations should be replayed. Scheduled backups
remain disabled until explicitly re-enabled; stale queued mail is discarded.

## Panel email alerts

**Admin → Panel** supports Resend credentials, recipient, optional sender, and a
test email. Built-in incidents cover failed delivery, prolonged unhealthy apps,
failed/overdue panel backups, and sustained server disk use of at least 90%.
The durable outbox retries delivery and tracks recovery notices. The panel must
be running to send alerts; it cannot report its own total outage by email.

## Host disk pressure

Inspect server disk metrics and app image storage, then preview safe cleanup
with `ocd gc --server=<id>`. Use `--execute` within authorized cleanup scope.
This removes eligible unused images, not database volumes. Check operation
errors before retrying deployments after freeing space.
