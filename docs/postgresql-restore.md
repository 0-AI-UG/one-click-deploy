# Restoring a PostgreSQL app

Prebuilt PostgreSQL images may initialize extensions such as PGMQ when their
data directory is first created. A custom-format dump that also contains those
schemas can therefore fail against the pre-initialized database with errors
such as `schema "pgmq" already exists`.

Pause or otherwise isolate every writer before restoring, and verify the dump
and target names first. There are two supported workflows.

## Clean restore

Use this when the dump is authoritative and it is acceptable to replace
objects in the existing database:

```bash
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname="$DATABASE_URL" \
  backup.dump
```

`--clean --if-exists` removes dump-owned schemas and objects before recreating
them, including PGMQ objects present in both the image initialization and the
archive. Take a fresh backup before running it.

## Empty-target restore

This is the safer choice for a full production recovery. Connect to the
administrative `postgres` database, terminate target sessions, recreate the
application database, then restore into the empty target:

```bash
export ADMIN_URL='postgresql://postgres:<password>@<host>:<port>/postgres'
export TARGET_DB='ocd_db'

psql "$ADMIN_URL" --set=ON_ERROR_STOP=1 --set=TARGET_DB="$TARGET_DB" \
  --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'TARGET_DB' AND pid <> pg_backend_pid();" \
  --command='DROP DATABASE IF EXISTS :"TARGET_DB";' \
  --command='CREATE DATABASE :"TARGET_DB" OWNER postgres;'

pg_restore \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname="${ADMIN_URL%/postgres}/$TARGET_DB" \
  backup.dump
```

Keep the application isolated until `pg_restore` exits successfully and basic
schema/data checks pass. Then reload or redeploy dependent apps so their
containers receive the current connection variables.
