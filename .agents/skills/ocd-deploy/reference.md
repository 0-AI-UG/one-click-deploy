# OCD Reference

OCD checks out exact Git commits on dedicated BuildKit workers, publishes OCI
images, resolves immutable digests, and reconciles committed manifests. GitHub
push webhooks trigger delivery without GitHub Actions.

- [Concepts](docs/concepts.md)
- [Deploy and config](docs/deploy-and-config.md)
- [App manifest](docs/app-manifest.md)
- [Stack manifest](docs/stack-manifest.md)
- [Build workers and webhooks](docs/build-workers-and-webhooks.md)
- [Immutable images and health](docs/immutable-images-and-health.md)
- [Releases, promotion, and rollback](docs/releases-promotion-and-rollback.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Infrastructure and server enrollment](docs/infrastructure-and-enrollment.md)
- [Troubleshooting](docs/troubleshooting.md)
