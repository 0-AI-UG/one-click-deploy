<div align="center">

# One-Click Deploy

**An open-source, self-hosted PaaS for deploying apps to the cloud with a single click.**

Git repo in, live HTTPS app out. No Kubernetes, no YAML, no vendor lock-in.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/0-AI-UG/one-click-deploy?style=social)](https://github.com/0-AI-UG/one-click-deploy)

<!-- Add a screenshot here once available -->
<!-- ![Dashboard Screenshot](docs/screenshots/dashboard.png) -->

</div>

---

## What is One-Click Deploy?

One-Click Deploy is a self-hosted web panel that automates server provisioning, DNS configuration, TLS certificates, and container deployment. Go from a Git repo to a live, secured app in minutes — on your own infrastructure.

Think of it as a lightweight, self-hostable alternative to Heroku, Railway, or Render.

## Features

- **One-click deployment** from any Git repository — with a Dockerfile or auto-detected via [Railpack](https://railpack.io)
- **Automatic server provisioning** on Hetzner Cloud (more providers planned)
- **TLS certificates** via Caddy + Let's Encrypt, automatic and zero-config
- **DNS management** through Hetzner DNS API
- **Multi-app support** — deploy multiple apps per server with subdomain routing
- **Horizontal scaling** — manual replica count or auto-scaling policies (CPU/memory thresholds)
- **Infrastructure services** — deploy PostgreSQL, Redis, MySQL and more alongside your apps
- **Private networking** — services and replicas communicate over Hetzner's private network
- **Pause & resume** — scale apps to zero to save costs, wake them back up instantly
- **Web terminal** — SSH into servers, replicas, and service instances from the browser
- **Auto-redeploy on push** via GitHub webhooks
- **Durable operation engine** — deploys, migrations, and scaling survive panel restarts and resume where they left off
- **CLI (`ocd`)** — deploy from a local repo, tail logs, open a shell, manage envs and rollbacks from your terminal
- **Multi-user with RBAC** — granular permissions for deploy, scale, pause, terminal access, and more
- **Auth** — passkeys (WebAuthn), TOTP two-factor, and GitHub OAuth
- **Self-managing** — the panel deploys and manages itself like any other app

## Quick Start

### Option A: Bash (no Docker required)

Copy `example.panel.json` to `panel.json`, fill in your values, and run:

```bash
./scripts/bootstrap.sh
```

The script installs [Bun](https://bun.sh) if needed, provisions a Hetzner server, deploys the panel to it, and exits.

### Option B: Docker

```bash
docker run --rm \
  -e OCD_AUTO_DEPLOY='{
    "provider_token": "your_hetzner_token",
    "domain": "panel.example.com",
    "server_type": "cx22",
    "server_location": "nbg1",
    "dns_zone_id": "optional_hetzner_dns_zone_id"
  }' \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

Or mount a config file:

```bash
docker run --rm \
  -v $(pwd)/panel.json:/config.json:ro \
  -e OCD_AUTO_DEPLOY=/config.json \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

When the process exits with code 0, open `https://<domain>`, create your admin account on the one-time setup page, and you're done.

<details>
<summary><strong>Config reference</strong></summary>

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider_token` | yes | — | Compute provider API token (Hetzner Cloud) |
| `provider` | no | `hetzner` | Compute provider id |
| `domain` | yes | — | Domain for the panel (e.g. `panel.example.com`) |
| `server_type` | no | `cx23` | Hetzner server type |
| `server_location` | no | `nbg1` | Hetzner datacenter location |
| `dns_zone_id` | no | — | Hetzner DNS zone ID (auto-creates the A record) |
| `volume_size` | no | `10` | Persistent volume size in GB |
| `app_name` | no | `ocd-panel` | Container/resource name for the panel |
| `webhook_branch` | no | `main` | Git branch that triggers auto-redeploy |

</details>

## Prerequisites

- A [Hetzner Cloud](https://www.hetzner.com/cloud) account (more providers planned)
- A domain name (optional, for custom domains with auto-DNS)

## How It Works

1. **Configure** — Enter your Hetzner API token
2. **Deploy** — Provide a Git repo URL, pick a server (or create one), and optionally set a domain
3. **Done** — Infrastructure is provisioned, your container is built, DNS + TLS configured, and traffic is served

From that point on, the panel manages itself: redeploy, roll back, edit env vars, and view logs — all from its own UI or via the `ocd` CLI.

## CLI

Prebuilt `ocd` binaries are published for Linux, macOS, and Windows. Point it at your panel and deploy from any repo:

```bash
ocd login https://panel.example.com
ocd deploy                 # deploy current repo using .ocd-deploy.json
ocd logs my-app --tail=200
ocd ssh my-app -i          # interactive shell in the container
ocd envs                   # manage environments and variables
ocd redeploy my-app
ocd rollback my-app
```

Run `ocd help` for the full command list.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| UI | [React](https://react.dev) + [Tailwind CSS](https://tailwindcss.com) |
| Database | [SQLite](https://www.sqlite.org/) |
| Reverse Proxy | [Caddy](https://caddyserver.com) |
| Terminal | [xterm.js](https://xtermjs.org/) |

## Development

```bash
bun install
bun run dev               # starts the panel on :3001 with hot reload
bun run engine            # run the operation engine locally
bun run typecheck         # type-check without emitting
bun run build             # build the web bundle
bun run test              # run unit tests
bun run test:integration  # run integration tests
bun run build:cli         # compile the `ocd` CLI for all platforms
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE) — 0-AI UG
