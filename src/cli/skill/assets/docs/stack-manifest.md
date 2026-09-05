# `ocd-stack.json` Stack Manifest

Use a stack for apps that share dependency ordering and environment wiring.
Each app entry references its own `.ocd-deploy.json`; each child manifest can
build from Git or select an OCI image.

Stack `blog`, app key `api` becomes `blog-api`; app key `database` becomes
`blog-database`.

## Complete field reference

| Field | Meaning |
| --- | --- |
| `$schema` | Optional schema version; currently `1`. |
| `$llm` | Optional tooling metadata ignored by the engine. |
| `name` | Required stack identifier and resource prefix. |
| `description` | Optional human metadata. |
| `environment` | Existing shared production environment name. |
| `staging_environment` | Optional existing shared staging environment name; `null` clears the link. It does not create an environment or app. |
| `apps` | Required non-empty app map. |

App entries support:

- `apps.<key>.manifest`: required child manifest path relative to the stack;
- `apps.<key>.needs`: app keys that must become healthy first;
- `apps.<key>.domain`: override the child domain;
- `apps.<key>.public`: override child public routing.

Unknown nested fields and unknown `needs` targets are rejected.

## Dependency and environment behavior

Each child's `env` map defines its complete user runtime environment. The
stack selects an existing environment once; child manifests inherit it unless
they explicitly select another environment or detach with `null`. Omitting
the stack environment clears its selection. Deployment never creates or
changes stored values.

A consumer can declare `"DATABASE_URL": {"from": "apps.database.outputs.URL"}`.
The database declares `"outputs": {"URL": {"template":
"postgresql://{env.DATABASE_USER}:{env.DATABASE_PASSWORD}@{app.host}:{app.port}/{env.DATABASE_NAME}",
"secret": true}}`. Templates read the producer's resolved runtime variables.
The output is delivered directly to the consumer; it is not a shared stored key.

References infer dependency ordering. Keep `needs` for dependencies that have
no variable reference. Missing members, missing output names, and cycles fail
preflight. Dependencies become healthy before consumers; independent members
can proceed concurrently. Secret metadata propagates through derived outputs.

Treat staging as a separate delivery target. `ocd deploy stack` reconciles the
declared production app members; it does not synthesize staging siblings.
Create staging apps separately with their own manifests, environment, and
domain, then release their exact digests explicitly. Promote between explicit
app names only after validation; see
[Releases, promotion, and rollback](releases-promotion-and-rollback.md).

## Reconciliation

`ocd deploy stack` submits complete desired membership:

- selected members are built from the exact repository commit or resolved from
  their prebuilt image reference;
- existing member configuration is reconciled;
- omitted recorded members are destroyed;
- dependency ordering and shared ingress are reconciled;
- newly created side effects are compensated on failure;
- environments are retained on member or stack destruction;
- managed volumes are detached and retained, never silently destroyed.

Review the diff before removing or renaming a key; a rename is remove-plus-
create. Repository push webhooks normally build and reconcile the complete
stack. Use `ocd release <fully-qualified-app-name> --image <digest>` only for
an intentional artifact-only rollout after configuration is synchronized.

## Example

```json
{
  "$schema": 1,
  "name": "blog",
  "environment": "production",
  "apps": {
    "database": {
      "manifest": "apps/database/.ocd-deploy.json"
    },
    "api": {
      "manifest": "services/api/.ocd-deploy.json",
      "needs": ["database"],
      "public": false
    },
    "web": {
      "manifest": "services/web/.ocd-deploy.json",
      "needs": ["api"]
    }
  }
}
```
