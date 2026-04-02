# Database Schema

The desktop app uses SQLite in WAL mode via Bun's native `bun:sqlite` driver. Schema is defined in `src/bun/db.ts` with migrations in `src/bun/migrations.ts`.

## Tables

### servers

Hetzner servers managed by the app.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| name | TEXT | Server name |
| hetzner_id | INTEGER | Hetzner API server ID |
| ipv4 | TEXT | Public IPv4 address |
| ipv6 | TEXT | Public IPv6 address |
| type | TEXT | Server type (e.g., `cpx12`) |
| location | TEXT | Datacenter (e.g., `nbg1`) |
| status | TEXT | Current status |
| ssh_host_key | TEXT | SSH host key for verification |
| created_at | TEXT | ISO timestamp |

### apps

Deployed applications.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| server_id | TEXT FK | References servers.id |
| name | TEXT | App name (unique, DNS-safe) |
| domain | TEXT | Custom domain (nullable) |
| git_repo | TEXT | Git repository URL |
| dockerfile_path | TEXT | Path to Dockerfile in repo |
| container_port | INTEGER | Port the app listens on |
| env_vars | TEXT | JSON-encoded environment variables |
| status | TEXT | Current status (deploying, running, stopped, error) |
| deploy_log | TEXT | Log from most recent deploy |
| volume_id | INTEGER | Hetzner volume ID (nullable) |
| volume_mount | TEXT | Mount path inside container (nullable) |
| webhook_enabled | INTEGER | Whether auto-redeploy is on |
| webhook_secret | TEXT | Secret for webhook verification |
| webhook_branch | TEXT | Branch to watch for pushes |
| github_webhook_id | INTEGER | GitHub webhook ID (for cleanup) |
| created_at | TEXT | ISO timestamp |

### dns_records

DNS records created for apps (for cleanup on destroy).

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| app_id | TEXT FK | References apps.id |
| zone_id | TEXT | Hetzner DNS zone ID |
| record_id | TEXT | Hetzner DNS record ID |
| name | TEXT | Record name |
| type | TEXT | Record type (A, AAAA) |
| value | TEXT | Record value (IP address) |

### deployment_history

Record of each deployment for rollback support.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| app_id | TEXT FK | References apps.id |
| image_tag | TEXT | Docker image tag used |
| git_commit | TEXT | Git commit hash |
| status | TEXT | success or error |
| deploy_log | TEXT | Full deploy log |
| created_at | TEXT | ISO timestamp |

### settings

Key-value store for configuration.

| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Setting name |
| value | TEXT | Setting value |

Known keys: `dns_zone_id`, `default_server_type`, `default_location`

### schema_version

Tracks which migrations have been applied.

| Column | Type | Description |
|--------|------|-------------|
| version | INTEGER | Current schema version |

## Migrations

Migrations run automatically on app startup. Each migration is numbered and runs in order:

1. Add `ssh_host_key` column to `servers`
2. Create `deployment_history` table
3. Add `volume_id` and `volume_mount` columns to `apps`
4. Add webhook fields (`webhook_enabled`, `webhook_secret`, `webhook_branch`, `github_webhook_id`) to `apps`
