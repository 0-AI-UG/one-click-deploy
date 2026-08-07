# Deploy and Config

## Apply the manifest

Run from a Git repository with an `origin` remote:

```bash
ocd deploy
ocd deploy path/to/app.json
```

For image deployments, set `image.ref`; a Git remote is then unnecessary.

`ocd deploy` performs one sequence:

1. Read and validate the local manifest.
2. Resolve `environment` and `webhook.staging_environment` by name.
3. Resolve secret values from allowed local inputs.
4. Send a complete manifest payload with `apply_mode: "manifest"`.
5. Store the desired manifest server-side.
6. Invoke the canonical deploy engine path.

The same sequence handles first deploys and later deploys.

App deployment and desired-configuration application are CLI-only. The web UI
cannot submit this endpoint; it shows the last applied manifest and current
runtime state, plus operational controls such as restart, rollback, wake,
pause, promotion, and replica migration.

## Preview changes

```bash
ocd deploy --dry-run
```

Dry-run compares the local manifest with the stored desired manifest. It does
not apply configuration and does not deploy code.

## Apply without deploying code

```bash
ocd deploy --config-only
```

Config-only stores and applies the same complete manifest but skips code
deployment. It requires an existing app.

## Allowed deploy flags

```text
--set=KEY=VALUE
--auth-password-env=KEY
--server=ID
--dry-run
--config-only
```

`--set` and `--auth-password-env` supply values that must not be committed.
`--server` is a one-deploy operational placement override. All persistent
desired settings belong in the manifest.

## Repeated deploys

Run `ocd deploy` again after changing code or desired configuration. There is
no UI redeploy command and no separate config/settings/ingress mutation.
