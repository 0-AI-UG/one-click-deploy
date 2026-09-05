# Shared PostgreSQL backups

TypeScript running on Bun. The container uses PostgreSQL 17's `psql`, `pg_dump`
and `pg_dumpall` executables; it does not use Python.

Every six hours, enumerate all connectable non-template databases, dump each
database in custom format, validate each dump's catalog, and record extension
versions and SHA-256 checksums. Role definitions are included without passwords.
Database ownership and ACLs remain in the dumps. Backups are individually
consistent per database, not one transaction spanning all databases.

The archive uses AES-256-GCM with a random salt/nonce and a key derived using
scrypt. Uploads go to the connected OCD object-storage provider through scoped
authorization. The service downloads the encrypted object and verifies its
SHA-256 before publishing `complete.json` and updating its health marker.
Incomplete runs never publish a completion record. No automatic deletion of
historical backups is currently performed.

Configure `BACKUP_DATABASE_URL`, `BACKUP_ENCRYPTION_KEY` (32+ characters),
`OCD_STORAGE_URL`, and `OCD_STORAGE_TOKEN` as OCD environment values; both keys
and the database URL are secrets. The storage grant needs PUT and GET on the
backup prefix in an nbg1 bucket. Provider access keys stay in OCD.

Keep the encryption key in an independently recoverable secret store. Role
passwords must be recovered from OCD environment secrets. Losing either the
backup encryption key or all copies of those secrets prevents full recovery.

For recovery, use `decryptArchive` from `archive.ts` in a Bun script, then
extract the authenticated tar archive into an empty directory. Verify the
checksums in `manifest.json`, install its extension versions, review `roles.sql`,
and use `pg_restore` into an isolated PostgreSQL instance. Never run restoration
against production as a backup health check.

The binary format is `OCDPGB01` (8 bytes), salt (16), nonce (12), ciphertext,
and GCM authentication tag (16). The header is authenticated as additional data.

Runtime health allows 30 minutes for the first successful backup and thereafter
requires a success within the configured interval plus 30 minutes. Failed runs
retry after five minutes. A successful upload is not a substitute for an actual
restore rehearsal before database cutover.
