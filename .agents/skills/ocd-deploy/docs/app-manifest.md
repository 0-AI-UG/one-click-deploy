# App Manifest

The default `.ocd-deploy.json` is complete desired configuration for one app.
Unknown fields are rejected by default.

## Example

```json
{
  "$schema": 1,
  "name": "API",
  "suggested_app_name": "api",
  "build": {
    "repository": "https://git.example.com/team/product.git",
    "branch": "main",
    "dockerfile": "apps/api/Dockerfile",
    "context": ".",
    "image_repository": "registry.example.com/team/api",
    "webhook": false
  },
  "container_port": 3000,
  "environment": "production",
  "env": { "DATABASE_URL": { "from": "environment.DATABASE_URL" } },
  "domain": "api.example.com",
  "public": true,
  "replicas": 2,
  "health_check": { "mode": "http", "path": "/health", "expected_statuses": [200] },
  "volume": null
}
```

## Image source

Declare exactly one of `build` or `image`.

`image` is one OCI image-reference string, including Docker Hub shorthand such
as `postgres:17-alpine`. OCD resolves tags to a registry digest before changing
desired state and always runs the immutable digest.

For source builds, `build` contains:

- `repository`: HTTPS Git URL. Public or accessible with the configured
  read-only Git checkout token.
- `branch`: webhook branch, default `main`.
- `dockerfile`: safe repository-relative Dockerfile path.
- `context`: safe repository-relative Docker build context.
- `image_repository`: OCI repository where OCD pushes the build, without a tag
  or digest.
- `platform`: optional `linux/amd64`; this is the only supported runtime ABI.
- `cache`: optional boolean; `false` disables registry-backed BuildKit cache.
- `webhook`: whether signed push delivery is enabled, default `true`. The
  current push-webhook protocol integration is GitHub; use `false` with other
  Git providers and deploy exact commits through the CLI.

Paths must not be absolute, contain `..`, or use backslashes. Credentials never
belong in this object.

## Manifest catalogs

A catalog is an ordinary version-controlled directory of app manifests, not an
OCD resource or API. Deploy a catalog entry directly with `ocd deploy
path/to/.ocd-deploy.json`, or reference it from `apps.<key>.manifest` in an
`ocd-stack.json`. PostgreSQL, Redis, and similar infrastructure use the same app
lifecycle as every other manifest.

## Other top-level fields

`$schema`, `$llm`, `name`, `description`, `icon`, `build`, `image`,
`container_port`, `env`, `outputs`, `storage`, `command`, `cap_add`, `post_start`,
`environment`, required `volume` (`null` for none),
`suggested_app_name`, `domain`, `auth`, `replicas`,
`autoscaling`, `public`, `extra_volumes`, `memory_mb`, `cpu_limit`,
`health_check`, `internal_protocol`, `sticky`, `rate_limit_rps`,
`ip_allowlist`, `compress`, `public_port`, `public_protocol`,
`durability_class`, `placement_pool`, and `scale_to_zero_after` retain their
normal complete-desired-state semantics.

The `env` object maps variable names to literal strings or `{ "from":
"environment.KEY" }` / `{ "from": "apps.MEMBER.outputs.KEY" }` references.
Only mapped values are delivered; missing references fail deployment. No values
are generated or written to shared environments during deployment.

The `outputs` map defines `{ "template": "...", "secret": true }` values for
stack consumers. Templates accept `{app.host}`, `{app.port}`, and `{env.KEY}`.
Secrets propagate from referenced values; mark other sensitive outputs with
`secret: true`. See [Environments and secrets](environments-and-secrets.md).

Primary volumes are grow-only. Omission of `environment` detaches a standalone
app; stack members inherit their stack selection. Explicit `null` detaches.
Domain omission retains its existing value; an empty string clears it.

## Object storage bindings

`storage` maps binding names to `{ connection?, bucket, prefix, permissions, generation? }`.
Select a connection by ID or unique name. Omitting it selects the default for a new
binding; existing bindings keep their pinned connection. Permissions are `read`
(GET/HEAD), `write` (PUT), `delete`, and `list`. Prefix is explicit: use `""` for
bucket root or a relative prefix ending in `/`. Bucket creation is separate.

OCD creates a private token per app binding. `primary` injects `OCD_STORAGE_TOKEN`
and `OCD_STORAGE_URL`; `media` injects `OCD_MEDIA_STORAGE_TOKEN` and
`OCD_MEDIA_STORAGE_URL`. Values are injected independently of the env map and are
read-only. Use the OCD storage client, not a standard S3 SDK with this token.
Increment `generation` to rotate. Old grants are retired after replicas attest
to the new configuration. Removing `storage` removes the app's bindings.
Staging manifests must select their own explicit bucket/prefix scope.
