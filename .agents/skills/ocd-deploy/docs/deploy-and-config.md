# Deploy and Config

## Apply the manifest

Run from the repository containing `.ocd-deploy.json`, or pass its path:

```bash
ocd deploy
ocd deploy path/to/app/.ocd-deploy.json
```

OCD resolves the repository root and exact local `HEAD`, then follows the one
delivery source declared by the manifest:

- `build`: a worker clones the reachable commit, builds it, pushes to
  `build.image_repository`, and captures its immutable digest;
- `image`: OCD resolves the prebuilt tag or digest without a source checkout or
  build worker.

Both paths apply complete desired state and run only the immutable digest.

For a stack:

```bash
ocd deploy stack ocd-stack.json
```

Built members must use the same repository, branch, and exact commit for one
stack build. Prebuilt-image members need no build worker. OCD resolves all
selected artifacts before rolling out dependency levels.

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

## Allowed deploy flags

```text
--auth-password-env=KEY
--server=ID
--app=EXISTING_APP
--commit=SOURCE_SHA
--dry-run
--config-only
--allow-unknown
```

Set stored values with `ocd envs set`; `--auth-password-env` reads a local basic-auth password.
`--server` is a one-deploy placement override; persistent intent belongs in the
manifest.

For an intentional artifact-only update of an existing app, use `ocd release
<app> --image repository@sha256:digest`. It preserves stored configuration and
does not read a manifest.
