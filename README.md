# One-Click Deploy

Deploy applications to the cloud with a single click.

A self-hosted web panel that automates server provisioning, DNS configuration, TLS certificates, and container deployment — so you can go from a Git repo to a live, secured app in minutes.

## Features

- **One-click deployment** from any Git repository — with a Dockerfile or auto-detected via [Railpack](https://railpack.io)
- **Automatic server provisioning** — Hetzner Cloud today, more providers coming
- **TLS certificates** via Caddy (Let's Encrypt)
- **DNS management** through Hetzner DNS API
- **Multi-app support** — deploy multiple apps per server with subdomain routing
- **Horizontal scaling** — manual replica count or auto-scaling policies with CPU/memory thresholds
- **Infrastructure services** — deploy PostgreSQL, Redis, MySQL and more alongside your apps
- **Private networking** — services and replicas communicate over Hetzner's private network
- **Pause & resume** — scale apps to zero to save costs, wake them back up instantly
- **Web terminal** — SSH into servers, replicas, and service instances from the browser
- **Auto-redeploy on push** via GitHub webhooks
- **Multi-user with RBAC** — granular permissions for deploy, scale, pause, terminal access, and more
- **Auth** — passkeys (WebAuthn), TOTP two-factor, and GitHub OAuth
- **Self-managing** — the panel deploys and manages itself like any other app

## Prerequisites

- A cloud provider account — currently [Hetzner Cloud](https://www.hetzner.com/cloud) (more providers planned)
- A DNS zone on your provider (optional, for custom domains)

## Quick start

### Option A: Bash (no Docker required)

Copy `example.panel.json` to `panel.json`, fill in your values, and run:

```bash
./scripts/bootstrap.sh
```

The script installs [Bun](https://bun.sh) if needed, installs dependencies, provisions a Hetzner server, deploys a permanent copy of the panel to it, and exits.

### Option B: Docker

Pass the config inline:

```bash
docker run --rm \
  -e OCD_AUTO_DEPLOY='{
    "hetzner_token": "your_hetzner_token",
    "domain": "panel.example.com",
    "server_type": "cx22",
    "server_location": "nbg1",
    "dns_zone_id": "optional_hetzner_dns_zone_id"
  }' \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

Or load from a file:

```bash
docker run --rm \
  -v $(pwd)/panel.json:/config.json:ro \
  -e OCD_AUTO_DEPLOY=/config.json \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

### Config reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `hetzner_token` | yes | — | Hetzner Cloud API token |
| `domain` | yes | — | Domain for the panel (e.g. `panel.example.com`) |
| `server_type` | no | `cx23` | Hetzner server type |
| `server_location` | no | `nbg1` | Hetzner datacenter location |
| `dns_zone_id` | no | — | Hetzner DNS zone ID (auto-creates the A record) |
| `volume_size` | no | `10` | Persistent volume size in GB |
| `app_name` | no | `ocd-panel` | Container/resource name for the panel |
| `webhook_branch` | no | `main` | Git branch that triggers auto-redeploy |

Progress streams to stdout. When the process exits with code 0, open `https://<domain>`, create your admin account on the one-time setup page, and you're done. From that point on, the panel manages itself: redeploy, roll back, edit env vars, and view logs from its own app-detail page.

## Development

```bash
bun install
bun run dev         # starts the panel on :3001 with hot reload and SKIP_2FA=1
bun run typecheck
bun run build       # builds the web bundle into src/web/dist
bun run test        # runs unit tests
```

## Tech stack

- [Bun](https://bun.sh) — runtime and HTTP server
- [React](https://react.dev) — UI
- [Tailwind CSS](https://tailwindcss.com) — styling
- [Caddy](https://caddyserver.com) — reverse proxy & TLS on deployed servers
- [SQLite](https://www.sqlite.org/) — local app database

## How it works

1. **Configure** — Enter your Hetzner API token
2. **Deploy** — Provide a Git repo URL, pick a server (or create one), and optionally set a domain
3. **Done** — The app provisions infrastructure, builds your container, configures DNS + TLS, and starts serving traffic

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
