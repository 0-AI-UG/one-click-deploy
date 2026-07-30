# Environments and Secrets

## Environment resources

Environments are reusable variable bags:

```bash
ocd envs create production
ocd envs set production LOG_LEVEL=info
ocd envs set production --secret DATABASE_URL=...
ocd envs show production
```

Use `--secret-file`, `--secret-stdin`, `--from-env`, or `--from-dotenv` when a
secret should not appear in argv.

## Link an app declaratively

Set the environment name in `.ocd-deploy.json`:

```json
{
  "environment": "production"
}
```

Then run:

```bash
ocd deploy --dry-run
ocd deploy
```

Use `"environment": null` or omit the field to declare no shared environment.
The CLI resolves names to IDs only for the wire request; names remain the
portable manifest model.

## Declared app variables

The manifest `env` array describes required/default/secret inputs. Provide
non-committed values with repeatable `--set=KEY=VALUE`. Existing values from
the manifest-linked environment satisfy declared keys, and `--set` wins.

## Rollout after editing an environment

Environment variable resource commands may offer rollout behavior for all apps
already linked to that environment. This updates the variable bag; it does not
change which environment an app desires. App linkage changes only through the
manifest.
