# One-Click Deploy

Deploy Docker containerized applications to [Hetzner Cloud](https://www.hetzner.com/cloud) with a single click.

A self-hosted web panel that automates server provisioning, DNS configuration, TLS certificates, and container deployment — so you can go from a Git repo to a live, secured app in minutes.

## Features

- **One-click deployment** from any Git repository with a Dockerfile
- **Automatic server provisioning** on Hetzner Cloud
- **TLS certificates** via Caddy (Let's Encrypt)
- **DNS management** through Hetzner DNS API
- **Multi-app support** — deploy multiple apps per server with subdomain routing
- **Auto-redeploy on push** via GitHub webhooks
- **Self-managing** — the panel can deploy and manage itself like any other app

## Prerequisites

- A [Hetzner Cloud](https://www.hetzner.com/cloud) account with an API token
- A [Hetzner DNS](https://dns.hetzner.com/) zone (optional, for custom domains)

## Quick start

The panel is distributed as a Docker image. One `docker run` provisions a Hetzner server, deploys a permanent copy of the panel to it, wires up TLS and auto-redeploy webhooks, and exits. No browser involved.

```bash
docker run --rm \
  -e OCD_AUTO_DEPLOY='{
    "hetzner_token": "your_hetzner_token",
    "domain": "panel.example.com",
    "server_type": "cx22",
    "server_location": "nbg1",
    "github_pat": "optional_github_pat_for_auto_redeploy",
    "dns_zone_id": "optional_hetzner_dns_zone_id"
  }' \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

Or load the config from a file:

```bash
docker run --rm \
  -v $(pwd)/panel.json:/config.json:ro \
  -e OCD_AUTO_DEPLOY=/config.json \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

**Required fields:** `hetzner_token`, `domain`.
**Optional fields:** `server_type` (default `cx22`), `server_location` (default `nbg1`), `github_pat` (enables webhook auto-redeploy), `dns_zone_id` (auto-creates the A record), `volume_size` (default `10` GB), `app_name` (default `ocd-panel`).

Progress streams to docker logs. When the container exits with code 0, open `https://<domain>`, create your admin account on the one-time setup page, and you're done. From that point on, the panel manages itself: redeploy, roll back, edit env vars, and view logs from its own app-detail page. GitHub pushes trigger auto-redeploys via the webhook.

## Development

```bash
bun install
bun run dev         # starts the panel on :3001 with hot reload and SKIP_2FA=1
bun run typecheck
bun run build       # builds the web bundle into src/web/dist
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
