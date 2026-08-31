# App manifest catalog

These are ordinary OCD app manifests for common infrastructure images. Copy a
manifest into an application repository, adjust its name/environment/size, and
reference it from `ocd-stack.json` like any other app.

The catalog has no special runtime behavior or API. Images are resolved to an
immutable digest during deploy, credentials live in the selected environment,
and stack exports publish connection values to dependent apps.

- [`postgresql/17-alpine.ocd-deploy.json`](postgresql/17-alpine.ocd-deploy.json)
- [`redis/8-alpine.ocd-deploy.json`](redis/8-alpine.ocd-deploy.json)
