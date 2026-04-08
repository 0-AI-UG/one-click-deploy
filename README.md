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

The panel is distributed as a Docker image. Getting a permanent, self-hosted copy takes two steps.

### 1. Bootstrap locally

Run the panel on your laptop. This instance is temporary — it exists only long enough to deploy a permanent copy to a real server. `OCD_BOOTSTRAP=1` skips the login and setup wizard, and `HETZNER_TOKEN` seeds your API token so there's nothing to click through.

```bash
docker run --rm -p 3001:3001 \
  -e OCD_BOOTSTRAP=1 \
  -e HETZNER_TOKEN=your_hetzner_token_here \
  -v ocd-bootstrap:/app/data \
  ghcr.io/0-ai-ug/one-click-deploy:latest
```

Open <http://localhost:3001> — you land straight on the dashboard, no login.

### 2. Deploy the panel to a real server

On the **Deploy New App** page, click **Deploy this panel** at the top. The form is pre-filled with the correct repo, env vars, volume, webhook, and a fresh `JWT_SECRET`. Pick a server type, set a domain, click **Deploy**.

During the deploy, the local panel hands off a snapshot of its SQLite database to the hosted server's mounted volume (re-encrypting the Hetzner token with the hosted instance's new `JWT_SECRET`). The hosted container boots with full knowledge of itself, its server, and its token.

### 3. Finish on the hosted instance

Once the deploy completes, stop the local bootstrap container (`Ctrl-C`) and delete its `ocd-bootstrap` volume. Open `https://<your-domain>`. You'll see a short setup page — create your real admin account. That's the only account you'll keep, and the dashboard already shows `ocd-panel` and the Hetzner server running it.

From here on, the panel manages itself: redeploy, roll back, edit env vars, and view logs from its own app-detail page. GitHub pushes trigger auto-redeploys via the webhook.

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
