# Environments and secrets

## Contents

- [Environment model](#environment-model)
- [Commands](#commands)
- [Variable formats and precedence](#variable-formats-and-precedence)
- [Rollout modes](#rollout-modes)
- [Projections](#projections)
- [Secret handling](#secret-handling)
- [Copying and staging](#copying-and-staging)
- [Deletion](#deletion)

## Environment model

An OCD environment is a named durable variable bag. Apps link to it by ID.
Several apps may share one environment. Stack production members normally share
one; opted-in staging siblings may share another.

Secrets are encrypted at rest and masked when read through normal APIs/CLI.
Environment values are merged with platform-injected per-app networking values
when a container is created. A user-defined key wins when it intentionally
overrides a platform key.

Environment rows outlive app and stack deletion.

## Commands

```bash
ocd envs list
ocd envs show <name|id>
ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE ...]
ocd envs copy <name|id> <new-name>
ocd envs set <name|id> KEY=VALUE ... [options]
ocd envs unset <name|id> KEY [KEY...] [options]
ocd envs remove <name|id> [--copy-before-delete[=<backup-name>]]
ocd envs deleted
ocd envs restore <name|id>
ocd envs purge <name|id>
```

`show` prints plain values, masks secrets, and lists linked apps. `copy`
duplicates all entries including secret ciphertext.

## Variable formats and precedence

Plain values:

```bash
ocd envs set production LOG_LEVEL=info API_BASE=https://api.example.com
```

Secret values:

```bash
ocd envs set production --secret API_TOKEN="$API_TOKEN"
```

`--secret` marks the next `KEY=VALUE` entry. It may be repeated.

For manifest deploys, precedence is:

1. explicit `--set`;
2. current environment value;
3. manifest default;
4. required prompt.

For `ocd envs set`, default behavior merges by key. `--replace` makes the
submitted set authoritative and removes every omitted existing key.

## Rollout modes

Environment edits default to `redeploy`:

```bash
ocd envs set <env> KEY=VALUE --rollout=redeploy
```

Modes:

- `redeploy`: build current configured Git source and recreate affected apps;
- `restart`: recreate from the current image without building;
- `none`: persist only; containers remain stale until a later recreate.

Aliases:

```bash
--restart       # --rollout=restart
--no-rollout    # --rollout=none
```

Limit rollout to linked apps:

```bash
ocd envs set production FEATURE_X=true \
  --app=api --app=worker
```

The edit still changes the shared environment for every consumer. `--app`
limits the immediate rollout, not variable visibility. Non-selected linked apps
remain stale until recreated.

The UI/CLI reports `stale environment, redeploy required` for containers whose
environment snapshot predates a relevant change.

Set/unset waits for the complete cascade by default and fails if any child app
fails. `--async`/`--no-wait` returns after queueing. `--json` emits one stable
object with the environment, changed keys, rollout, affected count, operation
ID, status, and error.

## Projections

An app's environment projection controls which shared keys enter its container:

- `null`/omitted: all shared keys;
- `[]`: no shared user keys;
- `["DATABASE_URL", "LOG_LEVEL"]`: only named keys.

That raw storage model remains backward-compatible for standalone and existing
apps. Stack manifest intent is safer: a newly created stack member that omits
`apps.<key>.env` receives its child-manifest declarations plus generated
dependency keys. Use `apps.<key>.env_all: true` for an explicit all-key opt-in.
An existing stack member preserves its stored projection when neither field is
specified on a re-up.

Platform `OCD_INTERNAL_*` variables are injected regardless of an empty
projection. A user value with the same key overrides its generated value.

Environment change rollout selection respects projections: a stack member is
affected only when a changed key is visible to it.

## Secret handling

Follow these rules:

- Never put credentials in `.ocd-deploy.json`; declare the key with
  `required: true` and `secret: true`.
- Never put an HTTP basic-auth password in the manifest; use
  `auth.password_env`, CLI `--auth-password-env`, or the hidden prompt.
- Avoid displaying `ocd envs show` output in public logs even though stored
  secrets are masked; non-secret values may still be sensitive.
- Prefer `--secret-file KEY=PATH`, `--secret-stdin KEY`, `--from-env KEY`, or
  `--from-dotenv PATH`; these keep secret values out of process arguments.
- Plain `--set` and `--secret KEY=VALUE` values travel through process
  arguments and can appear in local process inspection or shell history.
- For automation, use ephemeral runners, masked CI variables, disabled shell
  tracing, and short-lived credentials.
- The server automatically encrypts suspicious plaintext names such as
  `PASSWORD`, `API_TOKEN`, `PRIVATE_KEY`, `DATABASE_URL`, and `REDIS_URL`, even
  when an old client sends `secret: false`, and returns a warning.

Safer interactive manifest flow:

```json
{
  "key": "API_TOKEN",
  "description": "Production API token",
  "required": true,
  "secret": true
}
```

The CLI prompts with hidden input when a TTY is available and fails with the
missing key list in non-interactive environments.

## Copying and staging

```bash
ocd envs copy production staging
```

Copying preserves secrets and service URLs. That makes it convenient but not
isolated. Before starting staging containers, replace production database,
queue, object-storage, and external-service credentials with staging-specific
values.

For stack webhook staging, every opted-in member uses the stack's one staging
environment. Prepare it before `ocd deploy stack --staging-env=staging`.

## Deletion

```bash
ocd envs remove <name|id>
```

Removal:

- always opens/requires OCD web UI approval;
- rejects `--yes`, including server-side rejection of legacy automation tokens;
- fails while any app links the environment;
- retains the environment and encrypted variables for seven-day recovery;
- is never invoked automatically by app or stack deletion.

`--copy-before-delete` makes a server-side recovery copy first; supply
`--copy-before-delete=<name>` to choose its name. `ocd envs deleted` lists
retired environments and recovery dates. `restore` reactivates one. `purge` is
blocked during the seven-day recovery window. After that window it becomes the
separate irreversible action and always requires browser approval. Active and
deleted environments both reserve their names.
