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

## Exact runtime configuration

The app manifest maps every runtime variable to a literal or a reference:

```json
{
  "environment": "production",
  "env": {
    "NODE_ENV": "production",
    "DATABASE_URL": { "from": "environment.DATABASE_URL" }
  }
}
```

Only mapped variables are delivered from the environment resource. Missing
references fail before rollout. An omitted env map means no user variables.
Omitting `environment` or setting it to `null` detaches a standalone app;
stack members inherit the stack selection unless their child manifest selects
another environment or explicitly uses `null`.

Deploy reads stored values; it never creates an environment, merges defaults,
prompts for missing variables, or modifies shared values. Literals remain in
the manifest. Keep secrets in environments and reference them explicitly.

Create credentials before deploying:

```bash
ocd envs generate production SESSION_SECRET --type=password
ocd envs generate production DATABASE_USER --type=username
```

Generation creates a missing value only; an existing value is retained.
Rotation is a separate explicit environment update.

## Injection and rollout

Values are resolved when containers are created, written to a protected host
env file, and passed through Docker's `--env-file`. They are runtime variables,
not build arguments or frontend compile-time configuration. Stored values are
encrypted; referenced secrets and derived secret outputs remain masked.

Environment updates roll out affected apps that reference changed keys.
`--no-rollout` leaves running containers unchanged until a later recreation.
App-to-app references use `apps.MEMBER.outputs.KEY`; see
[Stack manifests](stack-manifest.md). Outputs are resolved directly and are
never persisted into the shared environment.

## Object-storage access

Prefer app-owned `storage` bindings in the manifest; see
[Object storage bindings](app-manifest.md#object-storage-bindings).
Bindings need an existing bucket and administrator authorization to deploy.
OCD injects scoped tokens directly into each app, overriding same-named
app env values. Keep driver
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
