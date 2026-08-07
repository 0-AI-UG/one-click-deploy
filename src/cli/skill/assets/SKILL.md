---
name: ocd-deploy
description: Deploy, configure, operate, recover, and troubleshoot apps and stacks on One-Click Deploy (OCD).
---

# OCD Deploy

Use the `ocd` CLI for One-Click Deploy panels.

## Safety contract

- Inspect before mutating live resources.
- Use `ocd deploy --dry-run` before a material desired-configuration change.
- Treat `.ocd-deploy.json` as the complete desired app configuration.
- Use `ocd deploy` as the only CLI mutation for desired app configuration.
- Never put plaintext secrets in a manifest. Use `--set`, `--auth-password-env`, environment secrets, or interactive prompts.
- Do not delete, purge, rollback, migrate, promote, or recover resources without explicit user intent.

## Core model

The panel stores one desired manifest per app. `ocd deploy` reads the local
manifest, resolves environment names, sends a complete manifest application,
stores that desired state, and invokes the canonical deploy path.

`ocd deploy --dry-run` compares local desired state with the stored server
manifest. `ocd deploy --config-only` stores and applies the same manifest
without deploying code. Both are modes of `ocd deploy`, not separate mutation
commands.

App creation and desired-configuration mutation are CLI-only. The server
rejects browser deploy requests, and the UI renders manifest-owned app
configuration read-only. There is no UI redeploy/config/settings/ingress path.

Operational actions remain separate because they do not redefine desired app
configuration: wake, restart, rollback, pause, unpause, promotion, replica
migration, operation recovery, and inspection.

## Typical workflow

```bash
ocd login https://panel.example.com
ocd status
ocd deploy --dry-run
ocd deploy
ocd status
ocd logs my-app --tail=200
```

Configuration-only application:

```bash
ocd deploy --dry-run
ocd deploy --config-only
```

## Command map

```text
ocd deploy [manifest] [--set=KEY=VALUE] [--auth-password-env=KEY]
    [--server=ID] [--dry-run] [--config-only]
ocd deploy stack [manifest]
ocd apps
ocd app show <app>
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app>
ocd app availability <app>
ocd app scaling-events <app>
ocd app staging <app>
ocd app webhook status <app>
ocd logs <app> [--tail=N]
ocd restart <app>
ocd rollback <app> [--deployment=ID]
ocd promote <app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale migrate <app> <replica-id> --to=<server-id>
ocd envs <list|show|create|copy|rename|set|unset|deleted|restore|remove|purge>
ocd services
ocd stack <ls|status|logs>
ocd ops
ocd servers
ocd resources
ocd volumes
ocd ssh
```

## Documentation

- [Concepts](docs/concepts.md)
- [Deploy and config](docs/deploy-and-config.md)
- [App manifest](docs/app-manifest.md)
- [CLI reference](docs/cli-reference.md)
- [Environments and secrets](docs/environments-and-secrets.md)
- [Scaling, storage, and placement](docs/scaling-storage-and-placement.md)
- [Webhooks and promotion](docs/webhooks-and-promotion.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Reference index](reference.md)
