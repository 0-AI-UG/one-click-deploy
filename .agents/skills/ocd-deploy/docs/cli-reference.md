# CLI Reference

## Desired app configuration

```text
ocd deploy [manifest]
    [--set=KEY=VALUE]
    [--auth-password-env=KEY]
    [--server=ID]
    [--dry-run]
    [--config-only]
ocd deploy stack [manifest]
```

`ocd deploy` is the only CLI mutation for desired app configuration.

## App inspection

```text
ocd apps
ocd app show <app>
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app> [--since=SEC]
ocd app availability <app>
ocd app scaling-events <app>
ocd app staging <app>
ocd app webhook status <app>
ocd logs <app> [--tail=N]
```

## Operational lifecycle

```text
ocd restart <app>
ocd rollback <app> [--deployment=ID]
ocd promote <app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale migrate <app> <replica-id> --to=<server-id>
```

Wake and migration affect runtime state. Policy show is inspection-only.
Desired replicas and scaling policy belong in the app manifest.

## Environments

```text
ocd envs list
ocd envs show <name|id>
ocd envs create <name> [vars...]
ocd envs copy <name|id> <new-name>
ocd envs rename <name|id> <new-name>
ocd envs set <name|id> [vars...]
ocd envs unset <name|id> KEY...
ocd envs deleted
ocd envs restore <name|id>
ocd envs remove <name|id>
ocd envs purge <name|id>
```

App-to-environment linkage is declared with the app manifest’s `environment`
field and applied by `ocd deploy`.

## Other surfaces

```text
ocd services
ocd service catalog
ocd service create <name>
ocd stack <ls|status|logs>
ocd ops [--app=<app>]
ocd ops <id>
ocd ops logs <id>
ocd ops cancel|retry|finalize <id>
ocd servers
ocd resources
ocd volumes
ocd ssh
```
