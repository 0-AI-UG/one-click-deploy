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

The four temporary rehearsal databases were removed after confirming zero active
clients and successful backup restores. Subsequent backups cover the four
application databases plus postgres. Backup recovery instructions are in
`services/postgres-backup/README.md`. The one-off migration, rehearsal, PGMQ
upgrade, and temporary app/panel patch services were removed after completion.
Their source remains available in Git history; they are not normal application
startup or deployment dependencies.

## Resumed rollout verification

The interrupted session was resumed on 2026-09-05. Foody, Sight, Skyline and
Docs public health checks returned HTTP 200. The shared backup service passed
its configured health probe. The cluster contains only `foody`, `sight`,
`sight_docs`, `skyline` and `postgres`. Each project runtime role can connect
only to its own application database and has no superuser, create-database or
create-role attribute. No OCD environment retains raw S3 credential keys.

Sight's source build was blocked by four high-severity `fast-uri` advisories.
Commit `663e412` updates the root and Docs pins/lockfiles to 3.1.7. Both audits
pass, and the Docs, renderer and monitor images were built and deployed.
All four Skyline app images were also rebuilt from its committed main branch
and deployed successfully.

Remaining infrastructure blocker: the running panel reports `Hetzner API token
not configured`. This prevents its no-op verification of the detector's existing
10 GB volume (operation 3816) and detachment/retirement of the old Docs and
restore-test database volumes (operations 3832 and 3833). Their containers were
removed, but the original volumes remain intact; the obsolete app records show
`cleanup_failed`. Reconnect the Hetzner infrastructure provider before retrying
those cleanup operations. Do not delete the retained recovery volumes.

The app host (server 7) also exhausted its root filesystem during source-image
rollout. OCD's reviewed safe GC removed 60 unused images, safely skipped one,
and reclaimed 14,751 MiB while retaining running/rollback references and all
database volumes. This restored roughly 15 GB free space. The failed registry
login and revision-snapshot writes occurred while this filesystem was full.

Sight's core stack also stopped at the same provider-dependent Redis volume
check (operation 3875). The API and workers were then reconciled independently
using the committed stack's exact environment projections. Operations 3902,
3903 and 3904 completed successfully; `sight-web`, `sight-scan` and `sight-ops`
now use their original committed manifests, source 15, and images built from
`663e412`. No temporary image manifest remains on these apps. All four public
health checks still returned HTTP 200 after the retries. Stack-level status
continues to reflect the unresolved provider-volume operations, not a completed
cleanup; reconnect Hetzner before retrying full stack reconciliation.

### Provider regression identified

The missing-token error was caused by a regressed panel release, not missing
credentials. The provider assignment and encrypted `provider.hetzner-main.api_token`
record remained intact; a read-only Hetzner lookup returned HTTP 200. A panel
rebuild from main had omitted the previously deployed, uncommitted provider UI
and infrastructure adapter changes. Those sources were recovered from the known
provider-capable image and merged with all migration fixes. No credential
re-entry is required. The merged source passed typechecking, the UI build and
all 133 isolated test files (six localhost socket suites rerun outside sandbox).

### Resolved

The provider-capable panel is live from `cb853d1`, image
`ghcr.io/0-ai-ug/open-cli-deployment@sha256:afcd8b4c2d47591946b2799a9bc146ea1e8014857d8d2afccf15305e7637b20c`.
Both providers report configured, and the served UI includes Providers and
Infrastructure. Detector and Redis volume checks passed (3967, 3968). Skyline
and Sight complete stack reconciliations passed (3969, 3973), retiring the old
production database app records and retaining their recovery volumes. Docs and
restore-test cleanup also completed automatically (3964, 3963). No provider
credential re-entry or volume deletion was needed.
