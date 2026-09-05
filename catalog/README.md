# App manifest catalog

These are ordinary OCD app manifests for common infrastructure images. Copy a
manifest into an application repository, adjust its name/environment/size, and
reference it from `ocd-stack.json` like any other app.

The catalog has no special runtime behavior or API. Images are resolved to an
immutable digest during deploy, credentials live in the selected environment,
and stack outputs provide connection values to dependent apps.

- [`postgresql/17-alpine.ocd-deploy.json`](postgresql/17-alpine.ocd-deploy.json)
- [`redis/8-alpine.ocd-deploy.json`](redis/8-alpine.ocd-deploy.json)

Before deploying, create the selected environment and credentials explicitly:

```bash
ocd envs create production
ocd envs generate production DATABASE_USER --type=username
ocd envs generate production DATABASE_PASSWORD --type=password
ocd envs generate production REDIS_PASSWORD --type=password
```

Set `environment` in the owning stack (or standalone app). Consumers reference
`apps.database.outputs.URL` or `apps.redis.outputs.URL` in their own env map.
