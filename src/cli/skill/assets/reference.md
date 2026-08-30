# OCD Reference

OCD checks out exact commits from compatible HTTPS Git hosts on dedicated
BuildKit workers, publishes to compatible OCI registries, resolves immutable
digests, and reconciles committed manifests. GitHub push webhooks are an
optional trigger integration and require no GitHub Actions runner.

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
