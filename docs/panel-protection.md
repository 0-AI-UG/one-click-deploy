# Panel backups and email alerts

Open **Admin → Panel**. These settings protect OCD's own control-plane data.
Applications continue to own their PostgreSQL databases, PGMQ workers, and cron
scheduling; OCD does not back up application data or schedule application jobs.

## Enable backups

1. Connect and assign an S3-compatible provider in **Admin → Providers**.
2. Enter an existing bucket in **Panel backups**. Use a dedicated prefix per panel
   (default `ocd-panel`). The credentials need GetObject, PutObject, and DeleteObject
   access to that prefix. Bucket creation remains in the object-storage controls.
3. Create and download the recovery key. Save it **outside the panel**, together
   with the S3 endpoint, region, bucket, and independent S3 access credentials.
4. Enable daily backups and save. The first backup runs on the next engine tick.

Defaults are one backup every 24 hours and seven successful backups retained.
The path prefix and retention count (1–90) are optional advanced settings.
**Back up now** queues a backup even when the daily schedule is disabled.
The engine processes requests durably, without keeping the browser connected.
A failed scheduled backup retries after an hour; there is no catch-up burst.

Each `.ocdb` object contains a consistent SQLite `VACUUM INTO` snapshot, its
checksum, SSH directory files, the panel's credential encryption/JWT secret,
creation time, schema version, and recorded panel image. Configuration and
provider credentials stored in SQLite are included. Build caches, app volumes,
container images, application databases, external DNS, and infrastructure are
not included. Keep the panel image available in your registry.

The archive is gzip-compressed and authenticated/encrypted with AES-256-GCM using
a separate random recovery key. The key is encrypted in the panel's secret store
and can be shown again to an administrator. S3 receives only encrypted bytes.
OCD downloads each upload and checks its checksum before declaring success or
applying retention. Retention deletes only exact object keys recorded by this
panel. Failed deletions remain visible and are retried after subsequent backups.
With S3 versioning, bucket lifecycle rules are needed to expire old versions.

The current implementation supports a SQLite database up to 256 MiB and an
archive up to 512 MiB. A larger database fails the backup explicitly. Keep an eye
on backup status; this implementation is intended for small panels.

## Restore without the original panel

Stop the original panel and any separately running engine. Never run two active
panels against the same fleet. Restore onto a host with access to the recorded
servers, using the OCD release that created the backup. Restoration preserves
recorded server addresses and panel placement; it does not provision replacement
infrastructure or automatically move the panel to a different server.

Supply secrets through environment variables, not command-line arguments:

```bash
export OCD_S3_ENDPOINT=https://your-s3-endpoint.example
export OCD_S3_REGION=your-region
# Set these from your password manager or secret manager:
# OCD_S3_ACCESS_KEY, OCD_S3_SECRET_KEY, OCD_RECOVERY_KEY

bun run restore:panel --from s3://my-bucket/ocd-panel/backup.ocdb \
  --data-dir /srv/ocd-restored
```

`OCD_RECOVERY_KEY` is the downloaded 64-character key, without a trailing newline.
The destination directory must **not exist**. The restore command has no
connection to a running panel and does not open the ordinary panel database.
It downloads and authenticates the archive, verifies the database checksum,
SQLite integrity and foreign keys, and atomically installs the new directory.
A wrong key, corrupt database, incompatible schema, or existing destination
leaves the destination untouched.

For a previously downloaded object:

```bash
bun run restore:panel --file /safe/backup.ocdb --data-dir /srv/ocd-restored
```

The release container also includes the restore script. Mount a parent directory
in which it can create a new child (substitute your pinned OCD image):

```bash
docker run --rm \
  -v /srv/recovery:/restore \
  -e OCD_S3_ENDPOINT -e OCD_S3_REGION \
  -e OCD_S3_ACCESS_KEY -e OCD_S3_SECRET_KEY -e OCD_RECOVERY_KEY \
  --entrypoint bun "$OCD_IMAGE" run scripts/restore-panel.ts \
  --from s3://my-bucket/ocd-panel/backup.ocdb --data-dir /restore/panel
```

Ensure the container user can write the parent directory. Mount the resulting
directory as the replacement panel's `/app/data`, reusing the original panel's
networking and domain. Start the matching release with `OCD_DATA_DIR=/app/data`.
The recovered `jwt-secret` file is loaded automatically. Omit `JWT_SECRET`, or
supply the identical original value; a conflicting override is rejected rather
than silently making credentials unreadable. All restored private files are
mode 0600, inside restricted directories.

The panel starts with **automation paused**. Sign in using the restored account,
open **Admin → Panel**, confirm that the original panel is stopped, and choose
**Verify servers and resume**. OCD checks pinned SSH host keys and Docker access
to every recorded server before permitting saved operations and reconciliation
to resume. If any check fails, it remains paused. Review the saved operation count
before resuming: an older backup may contain operations whose effects occurred
after that backup. This access check does not prove application data consistency.

Daily backups remain disabled after restore so an old retention history cannot
immediately prune backups. Confirm the destination and enable backups again.
Pending emails from the old snapshot are discarded to avoid replaying stale mail.

## Email alerts

Enter a **Resend API key** and **recipient email**, enable alerts, and save. No
manifest edits, SMTP server settings, Slack, or webhook destinations are needed.
Use **Send test email** to check the saved configuration.

The default sender is `OCD <onboarding@resend.dev>`. Resend's test sender can send
to the Resend account owner's address. To send to other recipients, set the
optional sender to an address on a verified Resend domain. See
[Resend's sending API](https://resend.com/docs/api-reference/emails/send-email)
and [sending errors](https://resend.com/docs/api-reference/errors).

Built-in rules cover:

- Failed delivery/build operations, grouped by target; a later successful delivery
  resolves the incident. Historical failures before enabling alerts are ignored.
- Apps unhealthy for two minutes. Planned paused/sleeping/deploying states do not
  open unhealthy incidents.
- Failed panel backups and no successful scheduled backup for 26 hours.
- Server disks at least 90% full for two minutes, based on recent metrics.

Incidents and a retrying outbox persist in SQLite. OCD sends one opening email
and one recovery email per incident; repeated evaluations do not send duplicates.
Each email has a short description and a panel link. Raw logs and environment
values are excluded. Delivery retries use the same payload and Resend idempotency
key, with exponential backoff capped at an hour and a maximum of 12 attempts.
Delivery status appears in the panel. Resend idempotency keys expire after 24
hours, so a retry after a longer panel outage may duplicate an accepted email.
Successful delivery history is retained for 30 days.

The panel must be running and able to reach Resend to send email. It cannot email
about its own total outage. Failed notification delivery stays visible in the
panel; it cannot reliably report itself through the same broken email channel.
