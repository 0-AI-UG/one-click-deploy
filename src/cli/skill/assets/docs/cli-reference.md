# CLI Quick Reference

This is a task-oriented command map. Run `ocd <command> --help` for every flag
and alias supported by that command.

## Build and delivery

```text
ocd deploy [manifest] [--auth-password-env=KEY]
    [--server=ID] [--dry-run] [--config-only] [--app=EXISTING_APP]
    [--commit=sha] [--allow-unknown]
ocd deploy stack [manifest] [--only=web,worker] [--with-dependents]
    [--changed | --all] [--config-only] [--commit=sha]
ocd release <app> --image <repository@sha256:digest>
    [--commit <sha>] [--idempotency-key <key>]
```

Normal deploys apply complete manifest configuration. A build manifest builds
the exact commit on an OCD worker; an image manifest resolves its prebuilt
reference without a worker. `release` is artifact-only and preserves stored
configuration.

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
ocd app availability <app>
ocd app scaling-events <app>
ocd app staging <app>
ocd app reload-env <app> --force
ocd app redeploy <app>
ocd logs <app> [--tail=N]
ocd restart <app>
ocd rollback <app> [--deployment=<id>]
ocd promote --from=<source-app> --to=<destination-app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale migrate <app> <replica-id> --to=<server-id>
ocd ops [--app=<app>]
ocd ops <id>
ocd ops logs <id> [--tail N] [--since TIME|CURSOR] [--child NAME|ID]
    [--phase STEP] [--follow]
ocd ops cancel <id>
ocd ops retry <id>
ocd ops finalize <id> [--status=auto|done|failed]
```

## Environments and infrastructure

```text
ocd envs <list|show|create|copy|rename|set|generate|unset|deleted|restore|remove|purge>
ocd envs generate <environment> <KEY> [--type=password|username]
ocd servers
ocd servers show <name|id> [--storage]
ocd servers diagnose <name|id>
ocd servers create --type=X --location=X
ocd servers enrollment-key
ocd servers connect --name=X --address=X --routing-address=X --host-key='...'
ocd servers delete <name|id>
ocd servers refresh
ocd servers pool <name|id> <pool>
ocd servers metrics [name|id] [--since=N]
ocd stack <ls|status|logs|member-logs>
ocd delete <app>
ocd delete stack <name>
ocd resources <ls|volume|volumes|delete>
ocd volumes <list|show|audit|ls|cat|delete>
ocd buckets <list|create|delete> [--storage=<connection>]
ocd storage list
ocd storage grant <app> <bucket> --prefix=path/ --token-file=/private/path
    [--storage=<connection>] [--methods=GET,HEAD,PUT,DELETE,LIST]
ocd storage revoke <grant-id>
ocd ssh
ocd cp <app|server>:/absolute/path <local-path> [--force] [--server] [--replica=ID]
```

`ocd cp` streams one regular file from an app container or server to the local
machine. It writes through a temporary file, verifies the received byte count,
and refuses to replace an existing destination unless `--force` is supplied.
Remote-to-local copies only are supported.

DNS has no mutation command. The panel displays records for the operator to
create at any DNS provider.

Buckets use a separately configured S3 access key, secret key, signing region,
and HTTPS endpoint. Bucket creation and deletion require browser approval;
deletion refuses non-empty buckets and never recursively removes objects.

`ocd volumes` lists provider disks; local directories appear in
`ocd servers show <name|id> --storage` and `ocd app show <app> --storage`.
Prefer manifest `storage` bindings for app-owned object access. Manual grant
commands are administrative and write a new mode-0600 token file without
printing the token. See [Environments and secrets](environments-and-secrets.md).
