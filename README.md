<div align="center">

# One-Click Deploy

**Self-hosted PaaS. Git repo in, live HTTPS app out.**

No Kubernetes. No YAML. No vendor lock-in.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/0-AI-UG/one-click-deploy/pkgs/container/one-click-deploy)
[![Stars](https://img.shields.io/github/stars/0-AI-UG/one-click-deploy?style=social)](https://github.com/0-AI-UG/one-click-deploy)

<!-- ![Dashboard](docs/screenshots/dashboard.png) -->

</div>

---

A lightweight, self-hostable alternative to Heroku, Railway, and Render. Point it at a Git repo and a Hetzner account — it provisions the server, builds your container, configures DNS, issues TLS, and serves traffic.

## Quick Start

```bash
docker run --rm \
  -e OCD_AUTO_DEPLOY='{"provider_token":"<hetzner_token>","domain":"panel.example.com"}' \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

Open `https://<domain>` and create your admin account. That's it.

Prefer bash? Copy `example.panel.json` to `panel.json` and run `./scripts/bootstrap.sh`.

## Features

- Deploy from any Git repo (Dockerfile or auto-detected via [Railpack](https://railpack.io))
- Auto-provisioned servers on Hetzner Cloud
- Auto TLS (Caddy + Let's Encrypt) and auto DNS
- Horizontal scaling, auto-scaling, pause/resume
- Managed services — Postgres, Redis, MySQL, more
- Web terminal, log streaming, rollbacks, webhooks
- Passkeys, TOTP, GitHub OAuth, multi-user RBAC
- `ocd` CLI for Linux, macOS, Windows
- Self-managing — the panel deploys itself

## CLI

```bash
ocd login https://panel.example.com
ocd deploy
ocd logs my-app --tail=200
ocd ssh my-app -i
```

## Development

```bash
bun install
bun run dev          # panel on :3001
bun run test
bun run build:cli
```

Built with [Bun](https://bun.sh), TypeScript, React, SQLite, and [Caddy](https://caddyserver.com).

## Links

- [Contributing](CONTRIBUTING.md)
- [Issues](https://github.com/0-AI-UG/one-click-deploy/issues) · [Discussions](https://github.com/0-AI-UG/one-click-deploy/discussions)
- [MIT License](LICENSE)
