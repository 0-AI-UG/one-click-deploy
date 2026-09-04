---
name: ocd-deploy
description: Build, deploy, configure, operate, recover, and troubleshoot applications on Open CLI Deployment (OCD).
---

# OCD Deploy

Use the `ocd` CLI for Open CLI Deployment panels. OCD owns provider-neutral HTTPS
Git checkout, BuildKit image creation, immutable OCI publication, manifest
reconciliation, and runtime rollout. GitHub signed push webhooks are an optional
trigger integration; GitHub Actions is not part of app delivery.

## Safety contract

- Inspect before mutating live resources.
- Use `ocd deploy --dry-run` before material configuration changes.
- Keep plaintext secrets out of manifests and logs. Use environments, `--set`,
  `--auth-password-env`, and panel Settings.
- Every runtime rollout still uses `repository@sha256:<digest>`. Mutable build
  tags are temporary transport only and never become desired runtime state.
- Webhook delivery checks out the exact pushed commit and reconciles the
  committed manifest or stack. Do not substitute `ocd release` when manifest,
  environment projection, or stack configuration may have changed.
- Before panel upgrades, back up the database and verify current image digests.
- Do not delete, purge, rollback, migrate, promote, or recover resources
  without explicit user intent.

## Core model

`.ocd-deploy.json` is complete desired state for one app. It declares exactly
one delivery source: a `build` object for OCD-owned Git/BuildKit delivery, or
an `image` reference for any prebuilt OCI image. Tags in `image` are resolved
to immutable digests before deployment. Credentials never belong in either.

For a `build` manifest, `ocd deploy` resolves the exact local Git commit, asks
a dedicated OCD build worker to clone that commit, pushes the result to
`build.image_repository`, records the registry digest, then reconciles the
complete manifest. A webhook-enabled build deploy creates a build source and
HMAC webhook secret.

For an `image` manifest, `ocd deploy` resolves the declared tag or digest and
reconciles the complete manifest without a source checkout, build worker, or
build source. Public images can be pulled anonymously; private images need a
matching registry connection.

A signed GitHub push webhook repeats that flow from the pushed SHA. For stacks,
OCD reads the committed stack and child manifests and deploys dependency levels.
This keeps environment projections and configuration synchronized with code.

`ocd release --image repository@sha256:digest` remains an advanced artifact-only
escape hatch. It changes the image while preserving stored configuration; it
does not read a manifest.

Private Git checkout and registry push/pull credentials are explicit scoped
connections, configured with `ocd source login` and `ocd registry login` or the
panel connection cards. Public repositories need no Git token. DNS remains
operator-owned; OCD only displays records. Hetzner remains optional
infrastructure.

## Typical workflow

```bash
ocd login https://panel.example.com
ocd doctor
ocd manifest validate .ocd-deploy.json
ocd deploy --dry-run
ocd deploy
ocd app show my-app
```

For a `build` manifest, also connect its output registry, check build capacity,
and optionally configure the GitHub push webhook:

```bash
ocd registry login registry.example.com/team --username=registry-user
ocd doctor
ocd runners sources
ocd runners webhook-secret <source-id>
```

Configure the returned URL and one-time secret in GitHub as an
`application/json` webhook for push events. Later pushes build and deploy in
OCD without GitHub Actions minutes.

## Command map

```text
ocd deploy [manifest] [--set=KEY=VALUE] [--auth-password-env=KEY]
    [--commit=sha] [--server=ID] [--app=EXISTING_APP]
    [--dry-run] [--config-only]
ocd deploy stack [manifest] [--config-only] [--commit=sha]
ocd release <app> --image <repository@sha256:digest> [--commit <sha>]
ocd doctor [manifest]
ocd registry <status|login|logout>
ocd source <status|login|logout>
ocd runners ls
ocd runners bootstrap
ocd runners install --server=<name|id> [--name=X]
ocd runners sources
ocd runners webhook-secret <source-id>
ocd runners remove <name|id>
ocd apps
ocd app show <app> [--storage]
ocd app deployments <app>
ocd app replicas <app>
ocd logs <app> [--tail=N]
ocd restart <app>
ocd rollback <app> [--deployment=<id>]
ocd promote --from=<source-app> --to=<destination-app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd envs <list|show|create|copy|rename|set|unset|deleted|restore|remove|purge>
ocd stack <ls|status|logs>
ocd manifest validate [path] [--allow-unknown]
ocd gc [--server=<name|id|ip>] [--execute]
ocd ops [--app=<app>]
ocd ops logs <id> [--tail N] [--since TIME|CURSOR] [--child NAME|ID]
    [--phase STEP] [--follow]
ocd servers
ocd servers enrollment-key
ocd servers connect --name=X --address=X --private-address=X --host-key='...'
ocd resources
ocd volumes
ocd buckets <list|create|delete>
ocd ssh
```

## Documentation

- [Concepts](docs/concepts.md)
- [Deploy and config](docs/deploy-and-config.md)
- [App manifest](docs/app-manifest.md)
- [Stack manifest](docs/stack-manifest.md)
- [Build workers and webhooks](docs/build-workers-and-webhooks.md)
- [Immutable images and health](docs/immutable-images-and-health.md)
- [Releases, promotion, and rollback](docs/releases-promotion-and-rollback.md)
- [CLI reference](docs/cli-reference.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Networking and ingress](docs/networking-and-ingress.md)
- [Infrastructure and server enrollment](docs/infrastructure-and-enrollment.md)
- [Scaling, storage, and placement](docs/scaling-storage-and-placement.md)
- [Operations and recovery](docs/operations-and-recovery.md)
- [Security and deletion](docs/security-and-deletion.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Reference index](reference.md)
