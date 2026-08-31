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
    "image": "registry.example.com/team/api",
    "webhook": false
  },
  "container_port": 3000,
  "environment": "production",
  "env": [{ "key": "DATABASE_URL", "required": true, "secret": true }],
  "domain": "api.example.com",
  "public": true,
  "replicas": 2,
  "health_check": { "mode": "http", "path": "/health", "expected_statuses": [200] },
  "volume": null
}
```

## Image source

Declare exactly one of `build` or `image`.

`image` accepts any OCI image reference, including Docker Hub shorthand such
as `postgres:17-alpine`. The established `{ "ref": "..." }` form is accepted
too. OCD resolves tags to a registry digest before changing desired state and
always runs the immutable digest.

For source builds, `build` contains:

- `repository`: HTTPS Git URL. Public or accessible with the configured
  read-only Git checkout token.
- `branch`: webhook branch, default `main`.
- `dockerfile`: safe repository-relative Dockerfile path.
- `context`: safe repository-relative Docker build context.
- `image`: OCI repository without tag or digest.
- `webhook`: whether signed push delivery is enabled, default `true`. The
  current push-webhook protocol integration is GitHub; use `false` with other
  Git providers and deploy exact commits through the CLI.

Paths must not be absolute, contain `..`, or use backslashes. Credentials never
belong in this object.

## Other top-level fields

`$schema`, `$llm`, `name`, `description`, `icon`, `build`, `image`,
`container_port`, `env`, `exports`, `command`, `cap_add`, `post_start`,
`environment`, required `volume` (`null` for none),
`suggested_app_name`, `domain`, `env_projection`, `auth`, `replicas`,
`autoscaling`, `public`, `extra_volumes`, `memory_mb`, `cpu_limit`,
`health_check`, `internal_protocol`, `sticky`, `rate_limit_rps`,
`ip_allowlist`, `compress`, `public_port`, `public_protocol`,
`durability_class`, `placement_pool`, and `scale_to_zero_after` retain their
normal complete-desired-state semantics.

An env declaration may use `generate: "password"` or `generate: "username"`;
the value is created only when the selected environment does not already have
the key. Stack `exports` publish dependency outputs using `{app.host}`,
`{app.port}`, and `{env.NAME}` templates. Mark credential-bearing outputs with
`secret: true`.

Primary volumes are grow-only. `environment` and `domain` are retention
exceptions: omission retains an existing value, while explicit `null` or `""`
clears it.

```bash
ocd manifest validate .ocd-deploy.json
```
