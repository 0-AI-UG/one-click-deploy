---
name: ocd-deploy
description: Deploy, configure, operate, recover, and troubleshoot externally built OCI images on One-Click Deploy (OCD).
---

# OCD Deploy

Use the `ocd` CLI for One-Click Deploy panels. OCD runs images; it never
checks out source code or builds an image.

## Safety contract

- Inspect before mutating live resources.
- Use `ocd deploy --dry-run` before material configuration changes.
- Use immutable `repository@sha256:<digest>` image references. Never deploy a
  mutable tag.
- Keep plaintext secrets out of manifests and logs. Use environment secrets,
  `--set`, `--auth-password-env`, or protected process environment variables.
- Before upgrading an older OCD panel, back up its database and
  verify every app plus the panel itself has a recorded immutable digest.
  The clean-cut schema upgrade refuses missing digests; never invent one.
- Do not delete, purge, rollback, migrate, promote, or recover resources
  without explicit user intent.

## Core model

`.ocd-deploy.json` is the complete desired configuration for one app and
contains its initial immutable `image.ref`. `ocd deploy` creates an app or
changes its configuration. It never builds the image.

CI publishes an image to any OCI registry, captures the registry digest, and
calls `ocd release`. A release changes only the app image and uses its stored
configuration. `ocd promote` copies the exact deployed digest between explicit
apps. `ocd rollback` selects an earlier successful deployment; it does not
rebuild or resolve a tag.

Public registries need no OCD credentials. For a private registry, an
administrator configures one OCI repository, username, and pull password/token
under panel Settings. OCD sends those credentials only when the image host
matches the configured repository host; credentials never belong in a
manifest or image reference.

DNS is operator-owned. OCD displays the records to create but never changes a
DNS provider. Hetzner is optional: OCD can provision managed Hetzner servers,
or an operator can enroll existing stateless Docker hosts.

Staging is explicit. Deploy staging as a separate app with its own manifest,
environment, and domain, release it by name, then promote its exact digest to
the production app. OCD does not infer or create a staging app from a
production deployment.

## Typical workflow

Initial app creation or configuration update:

```bash
ocd login https://panel.example.com
ocd manifest validate .ocd-deploy.json
ocd deploy --dry-run
ocd deploy
ocd app show my-app
```

CI release:

```bash
export OCD_PANEL_URL=https://panel.example.com
export OCD_TOKEN="$OCD_CI_TOKEN"
ocd release my-app \
  --image ghcr.io/example/my-app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --commit "$GITHUB_SHA"
```

## Command map

```text
ocd deploy [manifest] [--set=KEY=VALUE] [--auth-password-env=KEY]
    [--image=repository@sha256:digest] [--commit=sha]
    [--server=ID] [--app=EXISTING_APP] [--dry-run] [--config-only]
ocd deploy stack [manifest] [--config-only]
    [--image=MEMBER=repository@sha256:digest]... [--commit=sha]
ocd release <app> --image <repository@sha256:digest>
    [--commit <sha>] [--idempotency-key <key>]
ocd apps
ocd app show <app> [--storage]
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app>
ocd app availability <app>
ocd app scaling-events <app>
ocd logs <app> [--tail=N]
ocd restart <app>
ocd rollback <app> [--deployment=<id>]
ocd promote --from=<source-app> --to=<destination-app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale migrate <app> <replica-id> --to=<server-id>
ocd envs <list|show|create|copy|rename|set|unset|deleted|restore|remove|purge>
ocd services
ocd stack <ls|status|logs>
ocd manifest validate [path] [--allow-unknown]
ocd gc [--server=<name|id|ip>] [--execute]
ocd ops [--app=<app>]
ocd ops <id>
ocd ops logs <id> [--tail N] [--since TIME|CURSOR] [--child NAME|ID]
    [--phase STEP] [--follow]
ocd servers
ocd servers enrollment-key
ocd servers connect --name=X --address=X --private-address=X --host-key='...'
ocd runners <ls|install|remove|logs>
ocd resources
ocd volumes
ocd ssh
```

## Documentation

- [Concepts](docs/concepts.md)
- [Deploy and config](docs/deploy-and-config.md)
- [App manifest](docs/app-manifest.md)
- [Immutable images and health](docs/immutable-images-and-health.md)
- [Releases, promotion, and rollback](docs/releases-promotion-and-rollback.md)
- [CLI reference](docs/cli-reference.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Infrastructure and server enrollment](docs/infrastructure-and-enrollment.md)
- [GitHub Actions build runners](docs/github-actions-runners.md)
- [Scaling, storage, and placement](docs/scaling-storage-and-placement.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Reference index](reference.md)
