# Complete `ocd` CLI reference

## Contents

- [Global behavior](#global-behavior)
- [Authentication and discovery](#authentication-and-discovery)
- [App deployment and configuration](#app-deployment-and-configuration)
- [App inspection and narrow configuration](#app-inspection-and-narrow-configuration)
- [App lifecycle](#app-lifecycle)
- [Scaling and placement](#scaling-and-placement)
- [Stacks](#stacks)
- [Managed services](#managed-services)
- [Environments](#environments)
- [Servers, resources, and volumes](#servers-resources-and-volumes)
- [Operations](#operations)
- [SSH](#ssh)
- [Skill installation](#skill-installation)
- [Aliases and moved commands](#aliases-and-moved-commands)

## Global behavior

```bash
ocd help
ocd --help
ocd version
ocd --version
```

Most app, stack, environment, and server references accept a case-insensitive
name or a numeric ID. Commands that enqueue an engine operation print the
durable operation ID immediately and normally stream steps until terminal. If
event long-polling is unavailable, the CLI polls operation detail and reports
the last step/timestamp without repeating reconnect warnings.

The CLI persists panel URL and bearer token in
`$XDG_CONFIG_HOME/ocd/config.json`, or `~/.config/ocd/config.json` when
`XDG_CONFIG_HOME` is unset.

## Authentication and discovery

### `ocd login`

```bash
ocd login <panel-url>
ocd login
```

Starts a browser device flow. With no URL, reuse the saved panel URL. Approve
the displayed code in the panel; the CLI stores the resulting token locally.

### `ocd status`

```bash
ocd status
```

Shows app totals, app status/commit/address, services, and stale-environment
warnings. Staging sibling apps managed by webhook staging are not shown in the
main dashboard list.

### `ocd apps`

```bash
ocd apps
```

Lists every app with status, deployed commit, public/private address, and Git
repository. Includes a `stale environment, redeploy required` marker when a
container predates linked environment changes.

### `ocd servers`

```bash
ocd servers
```

Lists server name, public IP, type, location, and assigned apps.

### `ocd logs`

```bash
ocd logs <app> [--tail=N] [--replica=ID]
```

Prints container logs. Default tail is 100 lines. `--replica` selects one
running replica.

## App deployment and configuration

### `ocd deploy`

```bash
ocd deploy [manifest] [options]
```

Default manifest: `.ocd-deploy.json`.

Options:

| Flag | Behavior |
|---|---|
| `--domain=<domain>` | Override manifest domain for the applied configuration. |
| `--env=<name\|id>` | Link/reuse an environment. Existing values win over manifest defaults. |
| `--staging-env=<name\|id>` | Select the standalone webhook-staging environment. |
| `--auth-password-env=<key>` | Read the basic-auth password from a local process variable. |
| `--server=<id>` | Pin initial placement for this deploy; operational and nonportable. |
| `--set=KEY=VALUE` | Explicitly set/override an environment key; repeatable. |
| `--dry-run` | Print the non-secret desired-config diff; apply nothing and deploy nothing. |
| `--config-only` | Apply configuration to an existing app without deploying code. |

On a new app, `--dry-run` reports that the app would be created. `--config-only`
requires an existing app. Ordinary `ocd deploy` creates a missing app or
applies the complete manifest configuration to an existing app, then deploys
Git code.

Run inside a Git repository with an `origin` remote. The CLI records the
manifest path and content hash.

### `ocd config`

```bash
ocd config diff [manifest] [deploy options]
ocd config apply [manifest] [deploy options]
```

`config diff` is the explicit spelling of `ocd deploy --dry-run`.
`config apply` is the explicit spelling of `ocd deploy --config-only`.
Both accept the deploy input flags because they use the same manifest parser.
Neither deploys code.

The diff omits secret values and environment payload values. `config apply`
updates stored desired configuration for the next rollout and immediately
syncs applicable ingress state.

### `ocd redeploy`

```bash
ocd redeploy <app>
```

Queues a fresh build/deployment from the app's stored Git repository and branch
using stored desired configuration. It does not read `.ocd-deploy.json`.

## App inspection and narrow configuration

```bash
ocd app show <app>
ocd app rename <app> <new-name>
ocd app deployments <app>
ocd app replicas <app>
ocd app metrics <app> [--since=SECONDS]
ocd app availability <app> [--window=SECONDS]
ocd app scaling-events <app>
ocd app staging <app>
```

These expose app detail, deployment history, replica state, current/historical
metrics, availability, scaling events, and webhook-staging state.

```bash
ocd app webhook status <app>
ocd app webhook enable <app> [options]
ocd app webhook set <app> [options]
ocd app webhook disable <app>
```

Webhook options are `--branch=NAME`, `--path=PREFIX`,
`--wait-for-ci=true|false`, and `--staging-env=<name|id|off>`.

## App lifecycle

### `ocd restart`

```bash
ocd restart <app>
```

Recreates/restarts app containers from the current image. It does not build new
Git code. Use it to load current environment values without a build.

### `ocd rollback`

```bash
ocd rollback <app>
ocd rollback <app> --deployment=ID
```

Selects the previous successful deployment, or an explicitly selected
successful deployment, and rebuilds/redeploys its exact Git commit.

### `ocd pause` / `ocd unpause`

```bash
ocd pause <app>
ocd unpause <app>
```

Pause stops the app without deleting it. Unpause starts it again. These
operations do not recreate a container solely to refresh environment values;
use restart/redeploy when configuration must enter a new container.

### `ocd delete`

```bash
ocd delete <app> [--yes]
ocd delete stack <name|id> [--suspend-webhooks]
```

App deletion removes containers, routing, DNS, webhook registration, and the
app row. It detaches/retains managed volumes and retains every linked
environment. Browser confirmation is the default; `--yes` is allowed only for
explicitly authorized app-deletion automation.

Stack deletion always requires web UI approval and does not accept `--yes`.
It automatically suspends/supersedes member webhook deployments and drops new
pushes after destruction begins. `--suspend-webhooks` explicitly requests this
default behavior; there is no keep-webhooks override.
See [security-and-deletion.md](security-and-deletion.md).

### `ocd promote`

```bash
ocd promote [--yes|-y]
ocd promote --from=<app> --to=<app> [--yes|-y]
ocd promote stack <name|id> [--yes|-y]
```

With no source/destination, run in the repo containing `.ocd-deploy.json`; OCD
derives `<name>-staging` and `<name>`. Explicit `--from` and `--to` must appear
together. Promotion rebuilds the destination at the exact successful commit
running in the source.

Stack promotion selects ready staging siblings and processes dependency levels
in order. In an interactive shell, prompt unless `--yes`; in a non-interactive
shell, `--yes` is required.

## Scaling and placement

```bash
ocd scale <app> <replicas>
ocd scale wake <app>
ocd scale policy show <app>
ocd scale policy set <app> [options]
ocd scale migrate <app> <replica-id> --to=<server-id>
```

Manual scaling accepts zero. Policy options are `--enabled`, `--min`, `--max`,
`--cpu`, `--memory`, `--requests`, `--cooldown`, and `--idle`. Exact placement
uses replica migration. Manual `scale --server` is intentionally unavailable
because current level-triggered convergence ignores that hint.

## Stacks

### `ocd deploy stack`

```bash
ocd deploy stack [manifest] [options]
```

Default manifest: `ocd-stack.json`.

| Flag | Behavior |
|---|---|
| `--set=KEY=VALUE` | Set shared fallback value; repeatable. |
| `--set=<app>.KEY=VALUE` | Supply a value from one app declaration; it still resolves the shared key. |
| `--env=<name\|id>` | Adopt an existing production environment on first stack creation. |
| `--staging-env=<name\|id>` | Select/remember the shared staging environment. |
| `--staging-env=` | Clear the remembered staging environment; an opted-in member can cause a new copy on the next deploy. |

The command reads the stack manifest and every child app manifest, reconciles
members in dependency order, streams the stack operation, and attaches to an
already-running equivalent stack deploy instead of enqueueing a duplicate.

### `ocd stack`

```bash
ocd stack ls
ocd stack status <name|id>
ocd stack logs <name|id>
ocd stack member-logs <name|id>
ocd stack redeploy <name|id>
```

- `ls` shows resource-derived status, last operation, member counts, and age.
- `status` separates current resource health from last-operation status and
  shows services/apps.
- `logs` prints the stored stack log. If a failed first deploy compensated and
  removed the stack row, it finds the most recent matching deploy operation and
  prints those logs instead.
- `member-logs` prints current container logs for every readable app/service.
- `redeploy` uses stored stack/member configuration and does not read local
  manifests.

Status separates current instance readiness from the latest related stack,
environment, app, or service operation.

## Managed services

```bash
ocd services
ocd services list
ocd services ls
ocd service catalog
ocd service create <name> --type=<type> [options]
ocd service show <name|id> [--show-secrets]
ocd service restart|pause|unpause <name|id>
ocd service logs <name|id> [--tail=N] [--instance=ID]
ocd service inject <service> <environment> [--prefix=PREFIX]
ocd service uninject <service> <environment>
ocd service delete <service> --yes
```

`services` and `service` are command aliases. `catalog` is authoritative for
types, supported versions, default volumes, and statelessness.

Service create options:

| Flag | Behavior |
|---|---|
| `--type=<type>` | Required exact catalog key. |
| `--version=<tag>` | Catalog-supported image tag. |
| `--volume-size=<gb>` | Positive managed-volume size. |
| `--set=KEY=VALUE` | Override a service environment value; repeatable. |
| `--env=<name\|id>` | Inject generated credentials into an existing environment. |
| `--env-prefix=<prefix>` | Choose injected key prefix; requires `--env`. |
| `--domain=<domain>` | Custom domain for an HTTP-facing service. |

`ocd service deploy` is an alias of `service create`.

Show masks connection secrets by default. Lifecycle commands follow their
operations. Delete removes containers and retains managed volume data.
Injection/uninjection marks affected linked apps stale until restart/redeploy.

## Environments

```bash
ocd envs list
ocd envs show <name|id>
ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE ...]
ocd envs copy <name|id> <new-name>
ocd envs rename <name|id> <new-name>
ocd envs attach <name|id> <app>
ocd envs detach <name|id> <app>
ocd envs set <name|id> KEY=VALUE ... [options]
ocd envs unset <name|id> KEY [KEY...] [options]
ocd envs remove <name|id> [--copy-before-delete[=<name>]]
ocd envs deleted
ocd envs restore <name|id>
ocd envs purge <name|id>
```

Set/unset options:

| Flag | Behavior |
|---|---|
| `--secret KEY=VALUE` | Mark the next value secret/encrypted. |
| `--secret-file KEY=PATH` | Read a secret without putting its value in argv/history. |
| `--secret-stdin KEY` | Read one secret from stdin. |
| `--from-env KEY[=LOCAL_NAME]` | Read a secret from the local process environment. |
| `--from-dotenv PATH` | Import dotenv entries as encrypted secrets. |
| `--replace` | For `set`, replace the complete variable set instead of merging. |
| `--rollout=redeploy` | Rebuild linked affected apps; default. |
| `--rollout=restart` | Recreate from current image. |
| `--rollout=none` | Store only; containers remain stale until recreation. |
| `--restart` | Alias for `--rollout=restart`. |
| `--no-rollout` | Alias for `--rollout=none`. |
| `--app=<name\|id>` | Limit rollout to a linked app; repeatable. |
| `--wait` | Follow the cascade and fail when any child fails; default. |
| `--async`, `--no-wait` | Queue rollout and return its operation ID. |
| `--json` | Emit one structured rollout result on stdout. |

`envs duplicate` aliases `copy`; `envs delete` aliases `remove`.
Removal always requires web UI approval, fails while an app is linked, and is
recoverable for seven days. Purge is permanent and separately browser-gated.

Restart rollouts recreate from the current image using the same `ocd-net`,
internal aliases, limits, volumes, and routing inputs as normal creation. The
CLI warns when suspicious secret-like names are supplied as plaintext.

## Servers, resources, and volumes

### `ocd servers`

```bash
ocd servers ls
ocd servers show <name|id>
ocd servers diagnose <name|id>
ocd servers create --type=TYPE --location=LOCATION [--name=NAME]
ocd servers delete <name|id> [--yes]
ocd servers refresh
ocd servers pool <name|id> <pool>
ocd servers metrics [name|id] [--since=SECONDS]
```

Show includes workloads and host state. Diagnose focuses on processes,
listeners, networking, disk, and Docker. Pool affects future placement.
Deletion fails while workloads use the server.

### `ocd resources`

```bash
ocd resources
ocd resources topology
ocd resources volume <provider-volume-id>
ocd resources delete <server|volume> <id>
```

Inventory includes server/volume state and estimated monthly cost. Topology
shows app links and replica placement.

### `ocd volumes`

```bash
ocd volumes list
ocd volumes show <provider-volume-id>
ocd volumes attach <app> [--size=GB] [--mount-path=/data]
ocd volumes adopt <app> <provider-volume-id> [--mount-path=/data]
ocd volumes detach <app>
ocd volumes reattach <id> --from=<app> --to=<app> [--mount-path=/data]
ocd volumes resize <id> --size=GB
ocd volumes rename <id> <name>
ocd volumes audit
ocd volumes ls <id> [path]
ocd volumes cat <id> <path>
ocd volumes delete <id>
```

Detach retains data. Resize grows only. `cat` refuses binary data and limits
output to 256 KiB. Permanent delete fails while in use, always requires browser
approval, requires typing the exact provider volume ID, and rejects `--yes`.

New app/service volumes use operation-scoped provider names. Resume adoption
verifies retained ownership, size, location, and server before reuse.
Rename changes metadata only. Audit reports durable attempted permanent
deletions and their completed/failed outcome.

## Operations

```bash
ocd ops [--app <needle>] [--limit N]
ocd ops list [--app <needle>] [--limit N]
ocd ops engine
ocd ops <id>
ocd ops logs <id> [--since N] [--follow|-f]
ocd ops cancel <id> [--yes]
ocd ops retry <id>
ocd ops finalize <id> [--status auto|done|failed]
```

- List merges running, pending, and recent operations, then filters target
  labels/keys by the `--app` substring.
- `engine` shows heartbeat, configured concurrency, and operation kinds.
- Detail shows steps, compensation steps, children, error, trigger, and the
  commit found in step output.
- Logs use a numeric log cursor with `--since`; `--follow` long-polls until the
  operation is terminal.
- Cancel requests cancellation at a step boundary and may run compensation.
  Browser confirmation is default; authorized automation may use `--yes`.
- Retry resumes recoverable work or creates a fresh retry operation.
- Finalize assesses current resources. `auto` chooses the justified terminal
  result; an explicit status cannot force success when resources disagree.

## SSH

```bash
ocd ssh <app> <command>
ocd ssh <app> -i [--replica=ID]
ocd ssh <app> --interactive
ocd ssh <service> -i --service [--instance=ID]
ocd ssh <server> -i
ocd ssh <server> --server
```

Without `-i`, provide a remote command; CLI arguments after the target are
joined into that command. Quote shell expressions so the local shell does not
expand remote variables:

```bash
ocd ssh api 'printf "%s\n" "$DATABASE_URL"'
```

Use `--server` to disambiguate a server whose name collides with an app. Use
`--service` for managed services and `--instance` to select an instance.
Interactive mode uses a WebSocket terminal and forwards terminal resizing.

## Skill installation

```bash
ocd skill list
ocd skill install --agent <agent> [--dir <path>] [--force|-f]
```

- `list` prints supported agent targets and installation directories.
- `--agent` selects the target; it may also be supplied positionally.
- `--dir` chooses the project/install root; default is the current directory.
- Installation refuses to overwrite an existing skill unless `--force`.
- The installed bundle includes `SKILL.md`, the `docs/` manual, compatibility
  index, and example manifests.

Aliases: `skill ls`/`skill agents` for list, `skill add` for install.

## Aliases and moved commands

- `ocd services` and `ocd service` share one handler.
- `ocd resources volumes ...` and top-level `ocd volumes ...` share one
  handler.
- `ocd service deploy` aliases `service create`.
- `ocd envs duplicate` aliases `envs copy`.
- `ocd envs delete` aliases `envs remove`.
- `ocd stack up` is rejected; use `ocd deploy stack`.
- `ocd stack down` is rejected; use `ocd delete stack`.
