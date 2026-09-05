<div align="center">

# Open CLI Deployment

**A self-hostable, CLI-first PaaS.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/orgs/0-AI-UG/packages/container/package/open-cli-deployment)

</div>

OCD builds immutable images from Git and deploys them to your servers.

## Bootstrap the panel

For an operator-owned Docker host, copy `example.connected-panel.json`, add
its pinned SSH details, then run:

```bash
bun run bootstrap path/to/connected-panel.json
```

No cloud API is required. Optional managed provisioning is available by
copying `example.panel.json` and running:

```bash
OCD_PROVISIONER_TOKEN=... bun run bootstrap panel.json
```

Create the printed DNS record, then open the panel and create your admin
account. Omit `domain` to use a generated `nip.io` address instead.

## Deploy with the CLI

Apps use `.ocd-deploy.json`; stacks use `ocd-stack.json`.

```bash
ocd login https://panel.example.com
ocd registry login registry.example.com/team --username=registry-user
ocd source login git.example.com --username=git-user # private Git only
ocd doctor

ocd deploy .ocd-deploy.json
ocd deploy stack ocd-stack.json
```

```bash
ocd logs my-app --tail=200
ocd ssh my-app -i
ocd cp my-app:/tmp/export.tar.gz ./export.tar.gz
```

## Development

```bash
bun install
bun run dev
bun run test
bun run build:cli
```

[Documentation](docs/) · [Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)
