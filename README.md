# One-Click Deploy

Deploy Docker containerized applications to [Hetzner Cloud](https://www.hetzner.com/cloud) with a single click.

A desktop app that automates server provisioning, DNS configuration, TLS certificates, and container deployment — so you can go from a Git repo to a live, secured app in minutes.

## Features

- **One-click deployment** from any Git repository with a Dockerfile
- **Automatic server provisioning** on Hetzner Cloud
- **TLS certificates** via Caddy (Let's Encrypt)
- **DNS management** through Hetzner DNS API
- **Multi-app support** — deploy multiple apps per server with subdomain routing
- **App lifecycle management** — deploy, monitor, and destroy apps from the GUI

## Prerequisites

- A [Hetzner Cloud](https://www.hetzner.com/cloud) account with an API token
- A [Hetzner DNS](https://dns.hetzner.com/) zone (optional, for custom domains)
- An SSH key added to your Hetzner account

## Quick Start

Download the latest release for your platform from the [Releases](https://github.com/0-AI-UG/one-click-deploy/releases) page.

Or build from source:

```bash
bun install
bun run build
```

## Development

```bash
# Install dependencies
bun install

# Start with hot reload
bun run dev

# Type check
bun run typecheck

# Build
bun run build
```

## Tech Stack

- [Electrobun](https://electrobun.dev) — Desktop app framework (Bun-native)
- [React](https://react.dev) — UI
- [Tailwind CSS](https://tailwindcss.com) — Styling
- [Caddy](https://caddyserver.com) — Reverse proxy & TLS on deployed servers
- [SQLite](https://www.sqlite.org/) — Local app database

## How It Works

1. **Configure** — Enter your Hetzner API token and SSH key
2. **Deploy** — Provide a Git repo URL, pick a server (or create one), and optionally set a domain
3. **Done** — The app provisions infrastructure, builds your container, configures DNS + TLS, and starts serving traffic

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
