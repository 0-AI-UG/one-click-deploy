# CLI Reference

## Build and delivery

```text
ocd deploy [manifest] [--set=KEY=VALUE] [--auth-password-env=KEY]
    [--server=ID] [--dry-run] [--config-only] [--app=EXISTING_APP]
    [--image=repository@sha256:digest] [--commit=sha] [--allow-unknown]
ocd deploy stack [manifest] [--only=web,worker] [--with-dependents]
    [--changed | --all] [--config-only] [--commit=sha]
ocd release <app> --image <repository@sha256:digest>
    [--commit <sha>] [--idempotency-key <key>]
```

Normal deploys build the exact commit on an OCD worker and apply complete
manifest configuration. `--image` bypasses the build with a supplied digest.
`release` is artifact-only and preserves stored configuration.

## Readiness and build connections

```text
ocd doctor [manifest]
ocd registry <status|login|logout>
ocd source <status|login|logout>
```

Registry credentials are repository-namespace scoped; private source tokens are
host scoped. Public repositories need no source connection. Registry and source
connections are provider-neutral; GitHub is one supported choice rather than a
required account.

## Build infrastructure

```text
ocd runners ls
ocd runners bootstrap
ocd runners install --server=<name|id> [--name=X]
    [--removal-token-env=GITHUB_RUNNER_REMOVE_TOKEN]
ocd runners sources
ocd runners webhook-secret <source-id>
ocd runners remove <name|id>
```

The removal token is only for one-time conversion of an old Actions runner.
New OCD workers need no GitHub registration. A successful build-manifest deploy
creates a repository source; configure its printed HMAC URL/secret as a GitHub
push webhook.

## App and operations

```text
ocd apps
ocd app show <app> [--storage]
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app> [--since=SEC]
ocd logs <app> [--tail=N]
ocd restart <app>
ocd rollback <app> [--deployment=<id>]
ocd promote --from=<source-app> --to=<destination-app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd ops [--app=<app>]
ocd ops <id>
ocd ops logs <id> [--follow]
```

## Environments and infrastructure

```text
ocd envs <list|show|create|copy|rename|set|unset|deleted|restore|remove|purge>
ocd servers
ocd servers create --type=X --location=X
ocd servers enrollment-key
ocd servers connect --name=X --address=X --private-address=X --host-key='...'
ocd servers delete <name|id>
ocd stack <ls|status|logs>
ocd resources
ocd volumes
ocd ssh
```

DNS has no mutation command. The panel displays records for the operator to
create at any DNS provider.
