# Deploy and Config

## Apply the manifest

Run from the directory containing `.ocd-deploy.json`, or pass a path:

```bash
ocd deploy
ocd deploy path/to/app.json
```

The manifest must contain an externally published immutable `image.ref`. OCD:

1. reads and validates the complete local manifest;
2. resolves the named environment and protected secret inputs;
3. sends the exact image digest and complete desired configuration;
4. pulls that digest and starts a candidate;
5. commits the configuration revision only after readiness succeeds.

OCD does not need a source repository and never builds an image.

## Preview changes

```bash
ocd deploy --dry-run
```

Dry-run compares the local manifest with stored desired state. It does not
apply configuration or start a rollout.

## Retain the current deployed image

```bash
ocd deploy --config-only
```

Config-only requires an existing app. It applies complete configuration while
retaining the currently deployed immutable image. Control-plane changes may
apply in place; container-injected changes recreate containers from that same
digest.

## Allowed deploy flags

```text
--set=KEY=VALUE
--auth-password-env=KEY
--server=ID
--app=EXISTING_APP
--dry-run
--config-only
--allow-unknown
```

`--set` and `--auth-password-env` supply values that must not be committed.
`--server` is a one-deploy placement override. Persistent settings belong in
the manifest. Use `ocd release`, not `ocd deploy`, for routine CI delivery of a
new digest.
