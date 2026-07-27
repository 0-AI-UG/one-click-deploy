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
ocd envs remove <name|id>
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

## Projections

An app's environment projection controls which shared keys enter its container:

- `null`/omitted: all shared keys;
- `[]`: no shared user keys;
- `["DATABASE_URL", "LOG_LEVEL"]`: only named keys.

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
- `--set` and `--secret` values currently travel through process arguments.
  They can appear in local process inspection or shell history.
- For automation, use ephemeral runners, masked CI variables, disabled shell
  tracing, and short-lived credentials.
- OCD currently has no stdin/file secret-input flag.

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

Deletion:

- always opens/requires OCD web UI approval;
- rejects `--yes`, including server-side rejection of legacy automation tokens;
- fails while any app links the environment;
- is never invoked automatically by app or stack deletion.

Reassign/destroy linked apps first, verify the environment is unused, then
approve the explicit deletion in the UI.
