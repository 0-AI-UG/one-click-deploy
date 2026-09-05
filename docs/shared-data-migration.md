# Shared PostgreSQL and OCD storage rollout

Completed 2026-09-05. Applications use `ocd-shared-postgres.ocd.internal:5432`.
The cluster runs PostgreSQL 17.11, PGMQ 1.12.0, PostGIS 3.5.2 and pgvector 0.8.1.

| Project | Database | Runtime role | Verified tables |
| --- | --- | --- | ---: |
| Foody | foody | foody_owner | 97 |
| Sight | sight | sight_owner | 101 |
| Skyline | skyline | skyline_web / skyline_worker / skyline_detector | 63 |
| Docs | sight_docs | sight_docs_owner | 3 |

Every migration used a repeatable-read source snapshot, custom-format dump,
empty-target guard and per-table row-count verification. Rehearsals and final
copies both passed. Final copies ran with production writers stopped.
Project owners have no administrative role attributes and cannot connect to
other project databases. Skyline uses its owner only for migration/provisioning;
application processes use separately restricted roles. Sight pools are capped
at 8 per process; Skyline at 5 plus 3 authentication connections for web.

Skyline's source PGMQ was upgraded from 1.5.0 to 1.12.0 before migration.
All six queues and their active/archive tables are now included by ordinary
pg_dump. No legacy queue supplement is required. Pre-upgrade physical recovery
material was encrypted and verified in the nbg1 backup bucket.

## Object storage

Provider credentials remain in OCD. Application environments contain scoped
OCD tokens and the `/api/storage/authorize` endpoint, with raw S3 settings removed.

- Foody: `foody-blobs/foody/`, 356 migrated objects, SHA-256 verified.
- Sight: `sight-ceroai/sight/production/artifacts/`.
- Skyline private objects: `skyline-blobs`.
- Skyline public media: `skyline-media-nbg1`, 58 objects copied and verified.
  The Cloudflare CDN uses a read-only OCD grant; its R2 binding was removed.
- Historical Skyline backups: 12 objects copied from hel1 to
  `ocd-ceroai-backups/legacy/skyline/` and verified. The one-time copy grant was revoked.

## Shared backup

`ocd-postgres-backup` is the single active database backup service. TypeScript
runs on Bun, invoking PostgreSQL tools. Every six hours it dumps all connectable
non-template databases, encrypts the archive with AES-256-GCM, uploads through
OCD storage, downloads it and verifies SHA-256 before publishing completion.
Role definitions exclude passwords; credentials and encryption keys remain in
encrypted OCD environments. Historical backups are retained without automatic deletion.

The first populated-cluster backup covered nine databases including rehearsals:

- Object: `shared-postgres/2026-09-05T13-18-31-018Z-f2c6b72b-33e8-41f5-90d2-f6f01eabd3d9/cluster.ocdpg`
- Encrypted size: 341,338,676 bytes.
- SHA-256: `d17d2cb43bdaf5e1100f7421e9f11772e96d6dc09ec20c0a3fdf14e5e6e5ea39`.

The object was independently downloaded, authenticated, decrypted, and all dump
checksums verified. Foody, Sight, Docs and Skyline then restored successfully
into fresh databases in an isolated local PostgreSQL container. Skyline restored
PGMQ 1.12.0 and all six queues.

## Recovery and retirement

Old Foody, Sight, Skyline, Docs and restore-check PostgreSQL instances were
stopped after verification. Old backup and temporary migration jobs are stopped.
Their source volumes and original object copies are rollback material, not active
services. Stack manifests no longer create the old database or backup members.
Do not purge retained volumes until their recovery window is intentionally closed.

Rollback database settings are encrypted under `ROLLBACK_*` keys in each project
environment and excluded from app projections. After new writes occur, rollback
requires reconciling those writes; simply reconnecting an old database loses them.

Rehearsal databases remain isolated in the shared cluster and are included in
backups until explicitly retired. Backup recovery instructions are in
`services/postgres-backup/README.md`; migration tooling is in
`services/database-migration/`. Run those tools only as an intentional migration,
never as normal application startup.
