# OCD documentation index

This compatibility file preserves the historical `reference.md` link. OCD's
complete agent documentation is split under `docs/` so an agent can load only
the relevant domain.

- [Mental model and resource ownership](docs/concepts.md)
- [App manifest field reference](docs/app-manifest.md)
- [Stack manifest field reference](docs/stack-manifest.md)
- [Complete CLI reference](docs/cli-reference.md)
- [Deploy, config apply, revisions, and provenance](docs/deploy-and-config.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Stacks and managed services](docs/stacks-and-services.md)
- [Networking and ingress](docs/networking-and-ingress.md)
- [Scaling, storage, and placement](docs/scaling-storage-and-placement.md)
- [Webhooks, staging, and promotion](docs/webhooks-and-promotion.md)
- [Operations and recovery](docs/operations-and-recovery.md)
- [Security, confirmation, deletion, and retention](docs/security-and-deletion.md)
- [Troubleshooting](docs/troubleshooting.md)

Install the CLI from the panel that owns the target deployment:

```bash
curl -fsSL {{PANEL_URL}}/cli/install.sh | sh
ocd login {{PANEL_URL}}
```
