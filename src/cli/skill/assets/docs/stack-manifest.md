# `ocd-stack.json` stack manifest

## Contents

- [Purpose and naming](#purpose-and-naming)
- [Complete field reference](#complete-field-reference)
- [Dependency graph](#dependency-graph)
- [Shared environment and projections](#shared-environment-and-projections)
- [Reconciliation semantics](#reconciliation-semantics)
- [Example](#example)

## Purpose and naming

Use `ocd-stack.json` to deploy multiple apps and managed services with
dependency ordering, shared variables, generated credentials, and internal URL
wiring.

The stack name and member key form globally unique resource names:

- stack `blog`, app key `api` → app `blog-api`;
- stack `blog`, service key `database` → service `blog-database`.

Each app entry references its own `.ocd-deploy.json`. Do not inline app build or
runtime configuration into the stack manifest.

## Complete field reference

| Field | Type/default | Exact behavior |
|---|---|---|
| `$schema` | `1`, optional | Stack schema version. |
| `name` | non-empty string, required | Stack identifier and resource-name prefix. |
| `description` | string | Human metadata. |
| `services` | object map, optional | Managed-service members keyed by the desired injection prefix. |
| `services.<key>.type` | non-empty catalog key, required | Query `ocd service catalog`; use `postgresql`, not `postgres`. |
| `services.<key>.version` | string | Catalog-supported image version/tag. |
| `services.<key>.volume_size` | number `>=1` | Managed data volume size in GB. |
| `services.<key>.env_overrides` | string map | Override generated service environment values. |
| `services.<key>.domain` | string | Custom domain for an HTTP-facing service. |
| `apps` | non-empty object map, required | App members. |
| `apps.<key>.manifest` | non-empty string, required | Child app manifest path relative to `ocd-stack.json`. |
| `apps.<key>.needs` | string[] | Declared app/service keys that must become healthy first. |
| `apps.<key>.env` | string[] | Explicit shared-environment projection. `[]` means platform/dependency variables only. |
| `apps.<key>.env_all` | boolean, `false` | Explicitly send every shared key to this member. Cannot be combined with `env`. |
| `apps.<key>.domain` | string | Override the child manifest domain. |
| `apps.<key>.public` | boolean | Override the child manifest public setting. |

Unknown nested fields are rejected. Every `needs` target must name a declared
app or service.

## Dependency graph

`needs` forms a directed acyclic graph:

- cycles are rejected before deployment;
- dependencies deploy before consumers;
- a consumer starts only after all dependencies are deployed and healthy;
- independent members in the same level may run concurrently;
- promotion uses the persisted dependency levels as well.

A managed service usually appears in the `needs` list of apps that consume its
generated URL. An app dependency publishes its private URL under the uppercased
member key.

## Shared environment and projections

A stack has one production environment. OCD creates
`<stack>-stack-env` when needed, or adopts the environment passed with
`--env=<name|id>` on the first deploy. Later re-ups keep the remembered
environment; `--env` is not used to silently switch it.

All child manifest `env[]` declarations merge into this bag:

- `--set` wins over everything;
- an existing environment value wins over manifest defaults;
- one non-empty manifest default supplies a missing key;
- conflicting non-empty defaults are rejected unless an existing value or
  `--set` resolves the conflict;
- unresolved required variables prompt once.

Dependency injection names are derived from stack keys:

- app key `api`: `API_URL`;
- service key `database`: `DATABASE_URL`, `DATABASE_HOST`,
  `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`.

`_URL` and `_PASSWORD` service values are secret.

New stack members use least privilege by default:

- omit both `env` and `env_all`: receive keys declared in the child manifest
  plus variables generated for entries in `needs`;
- `[]`: receive no child-declared shared keys, but still receive dependency and
  platform-injected values;
- `["API_URL", "NODE_ENV"]`: receive only those shared keys.
- `"env_all": true`: explicitly receive the entire shared environment.

For backward compatibility, an existing stored member keeps its current
projection when a re-up omits both fields. Add `env` or `env_all` to make a
projection change explicit. OCD warns in stack logs when a public app receives
suspicious unrelated names such as `*_PASSWORD`, `*_TOKEN`, `*_SECRET`,
`*_PRIVATE_KEY`, or `*_API_KEY`; warning output contains names, never values.

Do not mark dependency-generated variables as `required` in a child manifest;
they do not exist at initial CLI prompt time.

## Reconciliation semantics

Re-running `ocd deploy stack` is a complete reconciliation:

- existing apps receive the complete child-manifest configuration and a
  code rollout;
- new apps/services are created;
- recorded members omitted from the new manifest are destroyed;
- reused/adopted resources are protected from stale compensation;
- newly created resources are compensated when the stack deployment fails;
- the production and staging environments are never deleted by member or stack
  destruction;
- managed volumes are detached and retained rather than provider-deleted.
- stack deletion automatically suspends pending member webhook deployments,
  cancels/compensates running webhook deployments, and drops pushes received
  after destruction begins.

Review the manifest diff before removing a member key. Renaming a key is
equivalent to destroying the old member and creating a new one.

## Example

```json
{
  "$schema": 1,
  "name": "blog",
  "description": "Public web app and private API",
  "services": {
    "database": {
      "type": "postgresql",
      "version": "17",
      "volume_size": 20
    }
  },
  "apps": {
    "api": {
      "manifest": "services/api/.ocd-deploy.json",
      "needs": ["database"],
      "env": ["DATABASE_URL", "JWT_SECRET", "NODE_ENV"],
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
