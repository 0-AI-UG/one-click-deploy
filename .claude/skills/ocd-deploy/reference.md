# OCD Reference

An app manifest declares exactly one delivery source. OCD can build an exact
Git commit on a dedicated BuildKit worker and publish it to
`build.image_repository`, or deploy any compatible prebuilt OCI reference from
`image`. Either way, OCD resolves an immutable digest before runtime rollout.
GitHub push webhooks are an optional trigger for build-backed manifests and
require no GitHub Actions runner.

- [Concepts](docs/concepts.md)
- [Deploy and config](docs/deploy-and-config.md)
- [App manifest](docs/app-manifest.md)
- [Stack manifest](docs/stack-manifest.md)
- [Build workers and webhooks](docs/build-workers-and-webhooks.md)
- [Immutable images and health](docs/immutable-images-and-health.md)
- [Releases, promotion, and rollback](docs/releases-promotion-and-rollback.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Networking and ingress](docs/networking-and-ingress.md)
- [Infrastructure and server enrollment](docs/infrastructure-and-enrollment.md)
- [Scaling, storage, and placement](docs/scaling-storage-and-placement.md)
- [Operations and recovery](docs/operations-and-recovery.md)
- [Security and deletion](docs/security-and-deletion.md)
- [Troubleshooting](docs/troubleshooting.md)
