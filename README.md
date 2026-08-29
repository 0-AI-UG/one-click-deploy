<div align="center">

# One-Click Deploy

**Self-hosted PaaS for Docker hosts, with optional Hetzner provisioning.**

Bring existing VPSs or let OCD provision managed capacity on Hetzner.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/0-AI-UG/one-click-deploy/pkgs/container/one-click-deploy)
[![Stars](https://img.shields.io/github/stars/0-AI-UG/one-click-deploy?style=social)](https://github.com/0-AI-UG/one-click-deploy)

</div>

---

A lightweight, self-hostable alternative to Heroku, Railway, and Render. Git supplies versioned runtime configuration; OCD checks out exact commits, builds with BuildKit, pushes immutable images to your registry, and deploys those digests to connected servers. Existing VPSs can be connected directly, while [Hetzner Cloud](https://www.hetzner.com/cloud) remains an optional convenience for provisioning servers and volumes. DNS stays operator-owned and provider-neutral.

## Quick Start

The headless bootstrap below creates the panel server on Hetzner and therefore
needs a [Hetzner Cloud API token](https://docs.hetzner.cloud/#getting-started)
with Read & Write access. Normal account setup and connected-host operation do
not require cloud credentials.

```bash
PANEL_IMAGE='ghcr.io/0-ai-ug/one-click-deploy@sha256:<64-hex-digest>'
docker run --rm \
  -e HETZNER_API_TOKEN='<hetzner_token>' \
  -e OCD_AUTO_DEPLOY="{\"panel_image_ref\":\"$PANEL_IMAGE\",\"domain\":\"panel.example.com\"}" \
  "$PANEL_IMAGE"
```

Bootstrap provisions the server and prints its IP. Open `https://<domain>` and create your admin account. That's it.

> **Existing installation:** this is a clean-cut release. Back up the OCD
> database and ensure every app and the panel itself have a real
> `repository@sha256:<digest>` recorded before starting the new version.
> Migration 105 deliberately refuses to start when any immutable artifact is
> missing; it never reconstructs or invents one from legacy source state.

### DNS

The panel needs `<domain>` to resolve to the new server so Let's Encrypt can
issue a TLS certificate. Bootstrap prints the exact `A` record to create with
your DNS provider. OCD observes propagation and reports whether the record is
pending, correct, or conflicting, but it never modifies or deletes DNS.

> **No domain?** Omit `domain` entirely. Bootstrap derives a `<server-ip>.nip.io` domain once the server exists and serves it with a self-signed certificate — no DNS setup and no real domain needed (your browser will warn on first visit). Just:
> ```bash
> PANEL_IMAGE='ghcr.io/0-ai-ug/one-click-deploy@sha256:<64-hex-digest>'
> docker run --rm \
>   -e HETZNER_API_TOKEN='<hetzner_token>' \
>   -e OCD_AUTO_DEPLOY="{\"panel_image_ref\":\"$PANEL_IMAGE\"}" \
>   "$PANEL_IMAGE"
> ```

Prefer a config file? Copy `example.panel.json` to `panel.json`, keep the token in your shell, and run `HETZNER_API_TOKEN=... bun run bootstrap`. Bootstrap remembers the chosen server type and location as future capacity defaults; it never writes provider or registry secrets into `panel.json`.

After installing the CLI, `ocd doctor` reports deploy readiness. The first
manifest build reuses an empty server for BuildKit or asks for browser approval
to provision a dedicated worker, installs it, and resumes the deploy. Registry
and private-source credentials are explicit scoped connections:

```bash
ocd registry login ghcr.io/acme --username=acme
ocd source login github.com                 # private repositories only
ocd doctor
ocd deploy
```

### Connect an existing VPS

After logging the CLI into the panel, print OCD's enrollment key, install it
for root on the VPS, independently verify the VPS's Ed25519 host-key
fingerprint, then connect it:

```bash
ocd servers enrollment-key
ocd servers connect \
  --name=app-1 \
  --address=203.0.113.10 \
  --private-address=10.0.0.11 \
  --host-key='203.0.113.10 ssh-ed25519 AAAA...'
```

Connected VPSs are stateless app capacity. OCD never deletes them or attaches
managed provider volumes; `ocd servers delete app-1` only disconnects the host.

## Features

- Build exact Git commits on dedicated OCD BuildKit workers
- Trigger full manifest/stack reconciliation from signed GitHub push webhooks, without Actions minutes
- Connect operator-owned stateless VPSs without cloud credentials
- Optionally provision managed Hetzner Cloud servers, volumes, networks, and firewalls
- Automatic TLS via Traefik and Let's Encrypt HTTP-01; provider-neutral DNS instructions
- Horizontal scaling, auto-scaling, pause/resume
- Managed services: Postgres, Redis, MySQL, and more
- Web terminal, log streaming, exact-image releases, promotions, and rollbacks
- Passkeys, TOTP, GitHub OAuth, multi-user RBAC
- `ocd` CLI for Linux, macOS, Windows
- Self-managing: the panel deploys itself

Managed PostgreSQL recovery: [clean and empty-target restore workflows](docs/postgresql-restore.md).
Retained volume recovery: [grace-period and reattachment workflow](docs/volume-recovery.md).
Build delivery: [OCD build workers and signed repository webhooks](.agents/skills/ocd-deploy/docs/build-workers-and-webhooks.md).

## CLI-only deployments

```bash
ocd login https://panel.example.com
ocd deploy .ocd-deploy.json
ocd deploy stack ocd-stack.json
ocd logs my-app --tail=200
ocd ssh my-app -i
```

Apps and stacks are created and configured only through versioned manifests
applied by the `ocd` CLI. The web panel is read-only for manifest-owned app
configuration and exposes operational controls such as restart, rollback,
pause, wake, promotion, migration, and recovery.

The single-app `.ocd-deploy.json` schema is also used by every app entry in
`ocd-stack.json`, so moving an app into or out of a stack does not change its
deployment capabilities.

## Development

```bash
bun install
bun run dev          # panel on :3001
bun run test
bun run build:cli
```

Built with [Bun](https://bun.sh), TypeScript, React, SQLite, and [Traefik](https://traefik.io).

## Links

- [Contributing](CONTRIBUTING.md)
- [Issues](https://github.com/0-AI-UG/one-click-deploy/issues) · [Discussions](https://github.com/0-AI-UG/one-click-deploy/discussions)
- [MIT License](LICENSE)
