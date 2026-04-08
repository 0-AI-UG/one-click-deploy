# Architecture

## System Diagram

```
+------------------------------------------+
|        Panel (Docker container)          |
|                                          |
|  +-------------------------------------+ |
|  |   Bun HTTP server (src/server/)     | |
|  |   - serves /api/*                   | |
|  |   - serves React SPA from           | |
|  |     src/web/dist/ (prod) or HMR     | |
|  +-------------------------------------+ |
|                |                         |
+----------------|-------------------------+
                 |
     +-----------+-----------+
     |                       |
Hetzner API             SSH to server
     |                       |
+----+------------+          +-> git clone
| Create server   |          +-> docker build
| Create volume   |          +-> docker run
| Create firewall |          +-> caddy reload
| DNS records     |
+-----------------+
```

## Source Layout

```
src/
  bun/                  # Backend business logic
    deploy/             # Deploy/redeploy pipeline orchestration
    hetzner/            # Hetzner Cloud + DNS API client, SSH operations
    db.ts               # SQLite database queries
    migrations.ts       # Schema migrations
    validate.ts         # Input validation for deploy requests
    secret-store.ts     # Encrypted SQLite secret storage (AES-GCM)
    github.ts           # GitHub API (webhooks, repo validation)
    paths.ts            # Data directory resolution
    reconciler.ts       # Background state sync loop
  server/
    index.ts            # Bun.serve setup, route table, SPA fallback
    routes/             # HTTP handlers grouped by concern
    lib/                # auth (JWT), permissions, CORS, errors
  web/
    index.html          # Dev entry (Bun HMR)
    src/
      index.tsx         # React root
      app.tsx           # React Router setup
      pages/            # Login, dashboard, deploy, app detail, settings, etc.
  shared/
    rpc.ts              # Shared TypeScript types
```

## HTTP API

The panel exposes a REST API under `/api/*`. Authentication is JWT-based (with optional TOTP), handled by `src/server/lib/auth.ts`. The deploy pipeline emits progress events via an SSE endpoint (`/api/apps/:name/deploy/stream`).

## Database

SQLite in WAL mode, managed by Bun's native `bun:sqlite` driver. Stored in `OCD_DATA_DIR` (defaults to `~/.ocp`, `/app/data` in the container).

### Tables

| Table | Purpose |
|-------|---------|
| `users` | Panel users + TOTP secrets + admin flag |
| `permissions` | Per-user permission grants |
| `servers` | Tracked Hetzner servers (ID, IP, type, location, SSH host key) |
| `apps` | Deployed applications (name, repo, port, env, status, webhook config) |
| `replicas` | Scaled app instances per server |
| `dns_records` | DNS records created for apps (for cleanup on destroy) |
| `deployment_history` | Past deployments (image tag, git commit, status, logs) |
| `scaling_events` | Autoscale history |
| `encrypted_secrets` | AES-GCM-encrypted API tokens (Hetzner, GitHub PAT) |
| `settings` | Key-value config (DNS zone ID, defaults) |
| `schema_version` | Migration tracking |

### Migrations

Migrations run automatically on startup. Each migration is a function that receives the database instance and runs SQL statements. The current version is tracked in `schema_version`.

## Hetzner Integration

All infrastructure operations go through `src/bun/hetzner/`:

- **Servers**: Create, delete, list, wait for ready state
- **Firewalls**: Auto-created per server (ports 22, 80, 443 open)
- **SSH keys**: Generated per deploy, registered with Hetzner
- **Volumes**: Create, attach, detach, delete
- **DNS**: Create/delete A records via Hetzner DNS API

SSH operations (git clone, docker build, etc.) are executed on the remote server with host key verification.

## Security Model

- API tokens stored encrypted in SQLite (AES-GCM, key derived from `JWT_SECRET` via HKDF)
- SSH host keys verified and stored on first connection
- Firewall auto-configured: only ports 22, 80, 443 open
- Container port not exposed publicly (Caddy proxies)
- Environment variables validated against reserved prefixes
- Git URLs validated to prevent shell injection
- App names restricted to DNS-safe characters
- JWT-based auth with optional TOTP second factor
