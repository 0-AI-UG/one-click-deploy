# CLI Reference

## Configuration and image delivery

```text
ocd deploy [manifest]
    [--set=KEY=VALUE]
    [--auth-password-env=KEY]
    [--server=ID]
    [--dry-run]
    [--config-only]
    [--app=EXISTING_APP]
    [--allow-unknown]
ocd deploy stack [manifest]
    [--only=web,worker] [--with-dependents]
    [--changed | --all] [--config-only]
ocd release <app> --image <repository@sha256:digest>
    [--commit <sha>] [--idempotency-key <key>]
```

`ocd deploy` creates an app or applies complete manifest configuration.
`ocd release` is the CI path for a new externally built digest; it preserves
the stored configuration. Neither command builds images.

Non-interactive CI may use `OCD_PANEL_URL` and `OCD_TOKEN`; they must be set
together. Interactive use can rely on `ocd login` saved credentials.

Private-image pull credentials have no CLI mutation command. An administrator
configures **OCI repository**, **OCI registry username**, and **OCI registry
password/token** in panel **Settings → Defaults**. The repository determines
the one registry host that may receive the credential; other hosts are pulled
anonymously. CI push credentials and `OCD_TOKEN` are separate.

## App inspection

```text
ocd apps
ocd app show <app> [--storage]
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app> [--since=SEC]
ocd app availability <app>
ocd app scaling-events <app>
ocd logs <app> [--tail=N]
ocd gc [--server=<name|id|ip>] [--execute]
```

## Operational lifecycle

```text
ocd restart <app>
ocd rollback <app> [--deployment=<id>]
ocd promote --from=<source-app> --to=<destination-app>
ocd pause <app>
ocd unpause <app>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale migrate <app> <replica-id> --to=<server-id>
```

Promotion copies the exact deployed source digest and requires browser
approval. Rollback selects a successful deployment record. Neither operation
resolves a tag or rebuilds an artifact.

Staging uses a separately deployed app. Neither `ocd deploy` nor `ocd release`
for production creates one implicitly.

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

App-to-environment linkage is declared by the manifest `environment` field and
applied with `ocd deploy`.

## Infrastructure

```text
ocd servers
ocd servers show <name|id>
ocd servers create --type=X --location=X
ocd servers enrollment-key
ocd servers connect --name=X --address=X --private-address=X --host-key='...'
ocd servers delete <name|id>
ocd servers pool <name|id> <pool>
ocd servers metrics [name|id] [--since=N]
```

`create` requires optional Hetzner provider configuration. `connect` enrolls
an operator-owned stateless Docker host with a verified Ed25519 host key.
`delete` destroys a managed provider VPS but only disconnects an external host.

## Other surfaces

```text
ocd services
ocd service catalog
ocd service create <name>
ocd stack <ls|status|logs>
ocd stack member-logs <name|id> [--tail N]
ocd manifest validate [path] [--allow-unknown]
ocd ops [--app=<app>]
ocd ops <id>
ocd ops logs <id> [--tail N] [--since TIME|CURSOR] [--child NAME|ID] [--phase STEP] [--follow]
ocd ops cancel|retry|finalize <id>
ocd resources
ocd volumes
ocd ssh
```

DNS has no mutation command. The panel displays the records an operator must
create at their chosen DNS provider.
