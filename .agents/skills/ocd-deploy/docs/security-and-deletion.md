# Security, authorization, deletion, and retention

## Contents

- [Authentication and CLI access](#authentication-and-cli-access)
- [Permission model](#permission-model)
- [Sensitive permissions](#sensitive-permissions)
- [Confirmation model](#confirmation-model)
- [Deletion matrix](#deletion-matrix)
- [App deletion](#app-deletion)
- [Stack deletion](#stack-deletion)
- [Environment deletion](#environment-deletion)
- [Volume/resource deletion](#volumeresource-deletion)
- [Secret safety](#secret-safety)

## Authentication and CLI access

The browser login/device flow issues a token marked with client type. Every
CLI-minted token additionally requires `cli.access`; revoking it disables CLI
use without removing the user's web grants.

Admins bypass ordinary permission checks. Non-admins require the exact
permission, globally or at a supported resource scope.

## Permission model

Read permissions:

- `fleet.view`, `apps.view`, `services.view`, `environments.view`,
  `metrics.view`, `operations.view`, `deployments.view`.

App permissions:

- `apps.deploy`, `apps.rollback`, `apps.restart`, `apps.pause`, `apps.destroy`,
  `apps.logs`, `apps.promote`.

Service/stack/environment:

- `services.deploy`, `services.manage`, `services.destroy`, `services.logs`,
  `services.link`;
- `stacks.view`, `stacks.deploy`, `stacks.promote`, `stacks.destroy`;
- `environments.manage`, `environments.secrets`.

Scaling/infrastructure:

- `scaling.migrate`;
- `servers.create`, `servers.manage`, `servers.delete`;
- `volumes.delete`, `volumes.files.read`;
- `resources.view`, `resources.delete`;
- `operations.cancel`, `panel.view`, `panel.manage`;
- `terminal.container`, `terminal.host`.

Scopes:

- app grants can cover an individual app;
- environment grants can cover that environment and applicable linked-app
  actions;
- stack permissions are scoped through the stack's environment;
- new-app deployment and infrastructure operations are global-only where no
  resource exists to scope yet.

`environments.manage` does not grant access to variable values.
`environments.secrets` is separately required to read/write them.

## Sensitive permissions

- Desired app settings, ingress, public ports, webhooks and scaling policy all
  use `apps.deploy`, and deployment endpoints additionally require a CLI token.
- `volumes.files.read` grants application-data access.
- `terminal.host` is effectively root-equivalent infrastructure access.
- `resources.delete`, `servers.delete`, and `volumes.delete` can remove
  provider resources/data.

Apply least privilege and prefer app/environment scopes.

## Confirmation model

High-risk destructive actions use a server-issued, single-use,
resource-bound confirmation. The CLI opens a web page showing an action
summary; the normal web panel converts its destructive dialog into the same
server-side confirmation. Approval is bound to:

- user;
- action;
- resource type;
- exact resource ID;
- expiry (about ten minutes).

The confirmation is consumed once. It cannot be replayed for another target.

There is no non-interactive approval token. Confirmation always comes from the
signed-in web UI.

Invariant:

- stack deletion always requires actual web UI approval;
- environment deletion always requires actual web UI approval;
- user-initiated permanent provider-volume deletion always requires web UI
  approval and typing the exact provider volume ID;
- the only unattended exception is an expired failed-deploy provisional volume;
  the reconciler rechecks that it has no live OCD owner and is provider-detached,
  then records the deletion in the permanent audit;
- legacy `--yes` automation tokens are rejected server-side for every action.

Bare authenticated stack/environment/provider-volume DELETE requests are
rejected. Permanent volume deletion additionally requires typing the exact
provider volume ID before the server marks the confirmation approved.

## Deletion matrix

| Action | Confirmation | Environment | Managed volume | Other effects |
|---|---|---|---|---|
| Delete app | Web UI always | retained | detached/retained | staging sibling, containers, DNS, ingress, webhook removed |
| Delete service | Web UI always | retained | detached/retained | containers and injected variables removed |
| Delete server | Web UI always | retained | workload volumes retained | may cascade through assigned workloads before provider deletion |
| Delete stack | Web UI always | production and staging retained | member volumes detached/retained | member webhooks suspended; all recorded apps/services destroyed |
| Delete environment | Web UI always | explicitly deleted only if unused | n/a | fails while apps link it |
| Cancel operation | Web UI always once compensation is possible | compensation depends on provisional ownership | compensation may detach created volume | runs operation rollback |
| Delete provider volume | Web UI + typed provider ID | n/a | provider data destroyed | irreversible; verify backup/ownership |
| Create server capacity | Web UI always | n/a | n/a | creates one or more billable provider resources; automatic deploy capacity uses the same gate |

## App deletion

App deletion cascades to its hidden webhook-staging sibling, then:

1. attempts GitHub webhook removal;
2. stops/removes containers and app directories;
3. removes managed DNS records;
4. detaches and retains volumes;
5. deletes app/replica rows only if cleanup gates succeed;
6. rerenders ingress;
7. garbage-collects eligible empty servers.

It never calls environment deletion. If cleanup partially fails, keep the app
row as `cleanup_failed`.

## Stack deletion

Stack deletion:

1. requires web UI confirmation;
2. enqueues a durable stack-wide destroy operation;
3. drops pending member webhook deployments and requests cancellation of
   running ones;
4. rejects/drops later webhook pushes, including pushes finishing a CI wait;
5. enqueues child destroy operations for every app/service;
6. waits for children;
7. logs retention of production/staging environments;
8. deletes only the stack row.

Confirmation text explicitly states environment and volume retention.
`--suspend-webhooks` is an explicit alias for the automatic default, not an
option that weakens the barrier.

## Environment deletion

Environment retirement:

1. requires `environments.manage`;
2. requires web UI confirmation;
3. verifies the exact environment still exists;
4. lists attached apps;
5. refuses deletion when any are attached;
6. records deletion and seven-day recovery timestamps only on explicit
   confirmed request.

There is no force flag.

Deleted environments keep encrypted variables, remain separate from active
selection, and can be listed/restored in the UI or with `ocd envs
deleted`/`restore`. During the seven-day recovery window, the protection can be
overridden only by the Purge button in the web environment view, after typing
the exact environment name. The CLI remains blocked until the window expires;
afterward purge is still a browser-confirmed action.

## Volume/resource deletion

Detachment/retention and provider deletion are different operations. App/stack
destroy performs the former. A later explicit volume delete can destroy data
and requires the corresponding global permission, a single-use resource-bound
browser approval, and the exact provider ID typed into the approval page.

Before provider deletion, verify:

- detached state and exact provider ID;
- former owner and intended target;
- backup/checksum;
- no recovery/rollback need;
- billing implications.

OCD creates a durable audit record before provider deletion and records the
actor, provider identity, former owner, retention state/dates, outcome, and
provider error. Inspect it with `ocd volumes audit`.

## Secret safety

- Store environment secrets encrypted; do not commit them.
- Keep GitHub tokens and webhook secrets out of logs.
- Prefer container-side access to connection URLs.
- Prefer `--secret-file`, `--secret-stdin`, `--from-env`, or `--from-dotenv` so
  secret values do not appear in process arguments or shell history.
- Do not send tokens, passwords, connection strings, or personal identifiers
  into issue comments, dashboards, or agent-visible output.
