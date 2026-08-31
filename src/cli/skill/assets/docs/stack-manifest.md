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
| `staging_env` | Values applied to the selected staging environment. It requires that environment and does not trigger a release. |
| `apps` | Required non-empty app map. |

App entries support:

- `apps.<key>.manifest`: required child manifest path relative to the stack;
- `apps.<key>.needs`: app keys that must become healthy first;
- `apps.<key>.env`: explicit shared-environment key projection;
- `apps.<key>.env_all`: explicitly expose every shared key; mutually exclusive
  with `env`;
- `apps.<key>.domain`: override the child domain;
- `apps.<key>.public`: override child public routing.

Unknown nested fields and unknown `needs` targets are rejected.

## Dependency and environment behavior

`needs` must form an acyclic graph. Dependencies become healthy before their
consumers; independent members can proceed concurrently. Dependency variables
use the stack member key: `api` publishes `API_URL`; `database` publishes
`DATABASE_URL` when the database app declares an `exports.URL` template.

All child `env[]` declarations merge into the shared environment. Explicit
sets win, existing values beat defaults, and conflicting defaults fail unless
resolved. New members receive only child-declared and dependency-generated
keys by default. Use `env_all` only when the member genuinely needs the full
bag.

Treat staging as a separate delivery target. `ocd deploy stack` reconciles the
declared production app members; it does not synthesize staging siblings.
Create staging apps separately with their own manifests, environment, and
domain, then release their exact digests explicitly. Promote between explicit
app names only after validation; see
[Releases, promotion, and rollback](releases-promotion-and-rollback.md).

## Reconciliation

`ocd deploy stack` submits complete desired membership:

- selected members are built from the exact repository commit;
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
      "manifest": "apps/database/.ocd-deploy.json",
      "env": ["DATABASE_PASSWORD"]
    },
    "api": {
      "manifest": "services/api/.ocd-deploy.json",
      "needs": ["database"],
      "env": ["DATABASE_URL", "JWT_SECRET"],
      "public": false
    },
    "web": {
      "manifest": "services/web/.ocd-deploy.json",
      "needs": ["api"],
      "env": ["API_URL", "NODE_ENV"]
    }
  }
}
```
