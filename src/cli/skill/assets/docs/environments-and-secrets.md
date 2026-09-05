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

Use `"environment": null` to detach the current environment. On an existing
app, omission retains its link. The CLI resolves names to IDs only for the wire
request; names remain the portable manifest model.

## Declared app variables

The manifest `env` array describes required/default/secret inputs. Provide
non-committed values with repeatable `--set=KEY=VALUE`. Existing values from
the manifest-linked environment satisfy declared keys, and `--set` wins.

## Rollout after editing an environment

Environment variable resource commands may offer rollout behavior for all apps
already linked to that environment. This updates the variable bag; it does not
change which environment an app desires. App linkage changes only through the
manifest.

## Object-storage access

Prefer app-owned `storage` bindings in the manifest; see
[Object storage bindings](app-manifest.md#object-storage-bindings).
Bindings need an existing bucket and administrator authorization to deploy.
OCD injects scoped tokens directly into each app, overriding same-named
shared-environment values and bypassing variable projection. Keep driver
selection such as `STORAGE_DRIVER=ocd` in normal configuration. The token is
for OCD's `/api/storage/authorize` API, not an S3 access key. Object bytes move
directly between the app and storage using short-lived authorized URLs.

Bindings do not copy objects. Explicitly migrate and verify objects before
changing a bucket/prefix. Staging needs its own scope. Managed grants retire
after all replicas attest to replacement configuration; app deletion revokes
managed grants. Standalone `ocd storage grant` grants must be revoked explicitly.
Revocation blocks new authorizations; already issued URLs can remain valid for
up to one hour. Provider credentials stay in the panel.

For a manual grant, use `--methods` to restrict access: readers need GET/HEAD;
a backup writer that verifies its uploads needs GET/PUT. Transfer the generated
token file into an encrypted environment and remove the temporary file. Do not
print tokens or place them in manifests.
