# Architecture

## System Diagram

```
+------------------------------------------+
|           Desktop App (Electrobun)        |
|                                           |
|  +------------------+  +---------------+  |
|  |   React Frontend |  |  Bun Backend  |  |
|  |   (BrowserView)  |<>|  (RPC host)   |  |
|  +------------------+  +---------------+  |
|                            |              |
+----------------------------|------ -------+
                             |
              +--------------+--------------+
              |              |              |
         Hetzner API    SSH to server   macOS Keychain
              |              |
     +--------+--------+    |
     | Create server   |    +---> git clone
     | Create volume   |    +---> docker build
     | Create firewall |    +---> docker run
     | DNS records     |    +---> caddy reload
     +----------------+
```

## Source Layout

```
src/
  bun/                  # Backend (runs in Bun)
    index.ts            # RPC handler registration
    deploy.ts           # Deploy pipeline orchestration
    hetzner.ts          # Hetzner Cloud + DNS API client, SSH operations
    db.ts               # SQLite database queries
    migrations.ts       # Schema migrations
    validate.ts         # Input validation for deploy requests
    keychain.ts         # macOS Keychain integration for secrets
    github.ts           # GitHub API (webhooks, repo validation)
  mainview/             # Frontend (runs in BrowserView)
    App.tsx             # Root component, routing
    components/
      deploy-section.tsx  # Deploy form + progress UI
      server-grid.tsx     # Server and app list
  shared/
    rpc.ts              # RPC type definitions (shared between frontend/backend)
```

## RPC System

Frontend and backend communicate via `BrowserView.defineRPC`. The RPC contract is defined in `src/shared/rpc.ts` as TypeScript types, giving both sides type safety.

**Pattern:** Frontend calls an RPC method -> Bun handler executes -> returns result or streams progress.

Deploy progress uses a callback pattern: the frontend passes a progress handler, and the backend calls it at each pipeline step.

## Database

SQLite in WAL mode, managed by Bun's native `bun:sqlite` driver.

### Tables

| Table | Purpose |
|-------|---------|
| `servers` | Tracked Hetzner servers (ID, IP, type, location, SSH host key) |
| `apps` | Deployed applications (name, repo, port, env, status, webhook config) |
| `dns_records` | DNS records created for apps (for cleanup on destroy) |
| `deployment_history` | Past deployments (image tag, git commit, status, logs) |
| `settings` | Key-value config (DNS zone ID, defaults) |
| `schema_version` | Migration tracking |

### Migrations

Migrations run automatically on startup. Each migration is a function that receives the database instance and runs SQL statements. The current version is tracked in `schema_version`.

## Hetzner Integration

All infrastructure operations go through `src/bun/hetzner.ts`:

- **Servers**: Create, delete, list, wait for ready state
- **Firewalls**: Auto-created per server (ports 22, 80, 443 open)
- **SSH keys**: Generated per deploy, registered with Hetzner
- **Volumes**: Create, attach, detach, delete
- **DNS**: Create/delete A records via Hetzner DNS API

SSH operations (git clone, docker build, etc.) are executed on the remote server via the `ssh2` library with host key verification.

## Security Model

- API tokens stored in macOS Keychain (never in SQLite or on disk)
- SSH host keys verified and stored on first connection
- Firewall auto-configured: only ports 22, 80, 443 open
- Container port not exposed publicly (Caddy proxies)
- Environment variables validated against reserved prefixes
- Git URLs validated to prevent shell injection
- App names restricted to DNS-safe characters
