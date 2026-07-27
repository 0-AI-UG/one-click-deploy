# OCD concepts and ownership model

## Contents

- [Three independent things](#three-independent-things)
- [Stored desired configuration](#stored-desired-configuration)
- [Operation semantics](#operation-semantics)
- [Resource ownership](#resource-ownership)
- [Configuration revisions](#configuration-revisions)
- [Environment ownership](#environment-ownership)
- [Stack ownership](#stack-ownership)
- [Current state versus operation history](#current-state-versus-operation-history)

## Three independent things

Reason about an OCD app as three independent axes:

1. **Source revision**: the Git repository, branch, and commit used to build an
   image.
2. **Desired configuration**: build paths, container port, linked environment,
   routing, resources, scaling, placement, webhook settings, and other runtime
   intent stored by OCD.
3. **Current resources**: containers, replicas, DNS/ingress configuration,
   volumes, environments, servers, and operation state that exist now.

A rollout combines a source revision with a desired-configuration revision.
Changing one does not inherently change the other.

## Stored desired configuration

OCD stores desired app configuration in its database. The web UI and manifest
apply paths write to the same model.

- A UI edit persists and remains active for later code-only redeploys.
- An environment edit updates the desired-configuration revision of every
  linked app.
- A manifest is not continuously watched and is not reread during an ordinary
  redeploy.
- A manifest apply is explicit and reconciles the complete
  manifest-controlled specification.

This avoids two competing live sources of truth. Git is authoritative for code;
OCD is authoritative for the configuration used by a rollout. A versioned
manifest is a repeatable way to apply configuration to OCD, not an invisible
file OCD consults on every operation.

## Operation semantics

| Operation | Reads manifest | Changes stored config | Builds code | Uses |
|---|---:|---:|---:|---|
| First `ocd deploy` | yes | creates it | yes | manifest + Git |
| Existing `ocd deploy` | yes | reconciles it | yes | newly applied config + Git |
| `ocd deploy --dry-run` | yes | no | no | manifest versus stored config |
| `ocd config diff` | yes | no | no | manifest versus stored config |
| `ocd config apply` | yes | yes | no | manifest only |
| `ocd redeploy` | no | no | yes | stored config + configured Git branch |
| `ocd restart` | no | no | no | current image + stored environment |
| `ocd rollback` | no | no | rebuilds pinned prior commit | stored config + selected history |
| Webhook production deploy | no | no | yes | webhook commit + stored config |
| Promotion | no | no | rebuilds exact staging commit | stored production config |

Ingress-only UI settings may take effect immediately without rebuilding a
container. Container-affecting settings are desired state for the next
recreate/redeploy unless the UI action also requests a rollout.

## Resource ownership

OCD distinguishes between lifecycle-owned resources and durable user-owned
resources:

- App containers, replicas, routing, DNS records, and webhooks belong to the
  app lifecycle.
- Stack membership rows belong to the stack lifecycle.
- Environments are durable configuration resources. They never belong to an app
  or stack deletion cascade.
- Managed volumes are durable data resources. Destroy operations detach and
  retain them for recovery rather than immediately deleting provider data.
- Adopted or reused resources are protected from compensation by operation
  ownership checks.

## Configuration revisions

Every app has a monotonic `config_revision`. Runtime/build configuration
changes advance it independently of Git commits. Environment-variable edits
advance every linked app's revision.

Successful deployment history captures the configuration revision used by that
deployment. An explicit manifest apply also records:

- the manifest path;
- its content hash;
- the apply timestamp;
- the resulting configuration revision.

The UI can therefore show that stored configuration has changed since the last
manifest apply. This is provenance and drift visibility, not an automatic
reconciliation mechanism.

Secrets and secret values are excluded from configuration diffs.

## Environment ownership

An environment is a named, reusable variable bag. Multiple apps may link to
one environment. Stack members normally share the stack's production
environment; staging members may share a separate staging environment.

Rules:

- Omitting `environment_id` during app config apply retains the current link.
- Manifest defaults do not overwrite values already present in the selected
  environment.
- Explicit `--set` values override existing values for that apply.
- Deleting an app or stack never deletes an environment.
- An environment can be explicitly deleted only when no apps use it.
- Every environment deletion requires approval in the OCD web UI.

## Stack ownership

A stack records its apps, managed services, dependency graph, production
environment, and optional staging environment.

Re-running `ocd deploy stack` reconciles declared membership:

- existing members receive the complete child-manifest configuration and are
  redeployed;
- new members are created;
- recorded members omitted from the new stack manifest are destroyed;
- the stack's remembered production environment is retained;
- the stack's staging environment is retained unless explicitly changed;
- deleting the stack destroys its members but retains both environments.

The stack manifest supplies graph wiring and limited per-member overrides.
Each child `.ocd-deploy.json` supplies that app's complete configuration input.

## Current state versus operation history

Operations are durable sagas with steps, child operations, compensation, and
terminal status. Their history explains what happened, but it is not the sole
authority for what exists now.

Examples:

- A failed operation can leave a healthy resource after successful
  compensation or later recovery.
- A healthy stack can report that its most recent stack operation failed.
- A stale operation can be finalized only after resource-derived assessment.

After any mutation, verify the resource view:

```bash
ocd status
ocd apps
ocd stack status <name>
ocd ops <id>
```
