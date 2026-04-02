# Managed Mode (Planned)

Managed mode is a free hosted alternative to self-hosted mode. Users sign in with GitHub and deploy to shared infrastructure — no Hetzner account needed.

## How It Works

1. User selects "Managed" mode in the app
2. Signs in with GitHub (OAuth flow)
3. Deploys apps via the same UI — requests go to our API server instead of Hetzner directly
4. Apps are available at `https://<app-name>.0-ai.app`

## Free Tier Limits

| Resource | Limit |
|----------|-------|
| Apps | 1 |
| RAM | 256 MB |
| CPU | 0.25 cores |
| Disk | 512 MB |
| Deploys | 3 per hour |
| Outbound traffic | 10 GB/month |

## Account Requirements

To prevent abuse, GitHub accounts must:
- Be older than 30 days
- Have a verified email address

## Infrastructure

- Shared Hetzner server pool (CCX22 instances)
- Each container runs in gVisor for security isolation
- Per-container network isolation via iptables
- Caddy reverse proxy with automatic TLS
- SQLite database for sessions, apps, and builds

## Sleep/Wake

To keep costs manageable, idle apps are put to sleep:
- After a configurable idle period with no incoming requests, the container stops
- On the next request, a loading page is shown while the container cold-starts
- Expected that ~80% of apps will be sleeping at any time

## Custom Domains (Planned)

Managed-mode apps will support custom domains:
1. Add your domain in the app settings
2. Create a CNAME record pointing to `<app-name>.0-ai.app`
3. Domain is verified automatically
4. TLS certificate provisioned via Let's Encrypt

## Rollout Phases

Managed mode is being built across phases 2-7 of the project roadmap:

- **Phase 2**: API server, GitHub OAuth, database, user/app CRUD
- **Phase 3**: Deploy pipeline, build workers, container isolation, SSE progress
- **Phase 4**: Desktop client integration (`src/bun/managed.ts`)
- **Phase 5**: Server agent, sleep/wake proxy
- **Phase 6**: Cloud-init server setup automation
- **Phase 7**: Pool auto-scaling, abuse detection, custom domains
