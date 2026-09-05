# Skyline PGMQ upgrade

Skyline was upgraded from PGMQ 1.5.0 to 1.12.0 on 2026-09-05.
`upgrade.sql` runs the upstream extension upgrade in a transaction, locks and
counts all existing PGMQ tables, and rejects any row-count change or table
that would remain excluded from ordinary backups.

The tested runtime image is:
`ghcr.io/0-ai-ug/ocd-shared-postgres@sha256:e43f62150d6e35bf1dd219f8f54542be6a5db818f5e374e51d8975b306238544`.
It preserves PostgreSQL 17.11, PostGIS 3.5.2 and pgvector 0.8.1.
Skyline's source Dockerfile also pins PGMQ 1.12.0 for future builds.

Validation: all 13 pre-existing PGMQ tables retained their row counts. A real
post-upgrade production dump restored normally into an isolated database with
all six queues and all twelve active/archive tables. The temporary legacy
queue-supplement migration code has been removed.

An encrypted pre-upgrade physical backup is stored in nbg1:
`ocd-ceroai-backups/pre-migration/skyline/20260905/physical-pgmq-1.5.0.tar.enc`.
Its download checksum was verified. The recovery key is the encrypted
`PRE_MIGRATION_BACKUP_ENCRYPTION_KEY` entry in Skyline's OCD environment.
Use `services/postgres-backup/archive.ts` to authenticate and decrypt the archive.
The prior runtime image for physical recovery was:
`ghcr.io/0-ai-ug/building-classification/bc-postgres@sha256:4e7ffb8392045f72b99500d3d6bcce2e5fa62167773951ea1cbc72e6205dd9e4`.
Recovery must target a separate volume; do not downgrade the upgraded live data.
