# Object storage cutover — 2026-09-05

The running panel at `ocd.cero-ai.com` was manually upgraded to schema 116 and the object-storage release. No startup migration for this cutover was added.

Final panel image:
`ghcr.io/0-ai-ug/open-cli-deployment@sha256:cae3d760acaa9ad17b1ac8c750776d10deec8670a405d0aa8cf61d3ab761b03b`

Ten running apps now use eleven app-owned bindings on connection `s3-compatible-3206399b` (`nbg1`). Existing buckets, prefixes, and permissions were preserved:

| Apps | Bucket | Prefix |
| --- | --- | --- |
| ocd-postgres-backup | ocd-ceroai-backups | root |
| sight-ops, sight-scan, sight-web | sight-ceroai | sight/production/artifacts/ |
| bc-detector, bc-worker, bc-web | skyline-blobs | root |
| bc-worker (media) | skyline-media-nbg1 | root |
| foody-api, foody-worker, foody-website | foody-blobs | foody/ |

Each runtime was checked against its app-owned grant, with a scoped upload and readback. Verification objects were removed. Six former shared grants were revoked after successful rollout; shared storage variables were removed from four environments after verifying that effective app environments stayed unchanged.

Source manifests were pushed in Sight `6616d8c`, Foody `e3aa1ed`, and Skyline `c6915d62`. Temporarily paused source webhooks were restored to their original settings. No panel backup schedule was enabled.

Private recovery snapshots remain on the panel data volume, including:

- `/app/data/pre-object-storage-1788627186787.sqlite` (before cutover)
- `/app/data/pre-storage-grant-retirement-1788628886879.sqlite` (before shared grant retirement)
- `/app/data/pre-storage-final-1788629752395.sqlite` (before final image update)

The successful schema-cutover snapshot path is recorded in `/app/data/storage-cutover-snapshot-path`. Two preexisting orphan WebAuthn credential rows referencing deleted users were removed during the offline integrity repair; the original rows remain in the snapshots. Database integrity and foreign-key checks passed.

One-time cutover scripts were kept outside the source tree. The final release source was frozen separately from concurrent workspace work. The app's object-storage cards use the existing overview card typography, two-column layout, label/value rows, and an OCD-managed badge.
