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
4. Resolve the exact local Git commit and canonical repo-relative build paths.
5. Send a complete manifest payload with `apply_mode: "manifest"`.
6. Build and health-check the candidate while the stored configuration remains unchanged.
7. Commit the desired configuration as one revision only after readiness passes.

The same sequence handles first deploys and later deploys.

Git deployments use a fresh detached checkout of the exact selected commit;
OCD never runs `git pull` in an existing app worktree. Dockerfile and context
paths are always resolved relative to the manifest that declared them.

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

Config-only stores and applies the same complete manifest without rebuilding
code. Control-plane changes apply in place. Runtime/environment changes
recreate containers from the current immutable image. Source/build changes are
recorded as pending until the next ordinary deployment. It requires an
existing app.

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
