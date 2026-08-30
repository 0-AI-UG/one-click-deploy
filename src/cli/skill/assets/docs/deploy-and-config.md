# Deploy and Config

## Build and apply the manifest

Run from the repository containing `.ocd-deploy.json`, or pass its path:

```bash
ocd deploy
ocd deploy path/to/app/.ocd-deploy.json
```

OCD resolves the repository root and exact local `HEAD`. The manifest declares
the source/build contract; an OCD worker clones that commit, pushes the built
image, captures its immutable digest, and applies the complete desired state.
The commit must already be reachable from the declared remote repository.

For a stack:

```bash
ocd deploy stack ocd-stack.json
```

All selected app members must use the same repository, branch, and exact commit
for one stack build. OCD builds them together and rolls out dependency levels.

## Preview changes

```bash
ocd deploy --dry-run
```

Dry-run compares desired configuration without building or starting a rollout.

## Retain the current deployed image

```bash
ocd deploy --config-only
```

Config-only applies complete configuration to an existing app while retaining
its current immutable image. Use it only when source bytes do not need a build.

## Advanced exact-image override

```bash
ocd deploy --image=registry.example.com/team/api@sha256:<64-hex-digest> --commit=<sha>
```

This bypasses the build worker but still applies the manifest. `ocd release`
is narrower: it updates only the image and does not read any manifest. Prefer a
normal build deploy or webhook whenever configuration might have changed.

## Allowed deploy flags

```text
--set=KEY=VALUE
--auth-password-env=KEY
--server=ID
--app=EXISTING_APP
--image=repository@sha256:DIGEST
--commit=SOURCE_SHA
--dry-run
--config-only
--allow-unknown
```

`--set` and `--auth-password-env` supply values that must not be committed.
`--server` is a one-deploy placement override; persistent intent belongs in the
manifest.
