# Concepts

## One desired manifest

Each app has one server-side desired manifest. A local `.ocd-deploy.json` is a
complete declaration, not a patch. `ocd deploy` resolves names and secrets,
sends `apply_mode: "manifest"`, updates the stored manifest, and invokes the
canonical deploy engine path.

Omitted nullable links become `null`; omitted booleans, counters, arrays, and
other fields are sent with their documented defaults. This prevents hidden
server state from surviving a complete manifest application.

## One mutation path

| Intent | Command |
| --- | --- |
| Preview local versus stored desired state | `ocd deploy --dry-run` |
| Apply desired state and deploy code | `ocd deploy` |
| Apply desired state without code deployment | `ocd deploy --config-only` |

The web UI patches only user-edited fields into the same stored manifest and
then calls the same deploy path. It does not maintain an independent settings
or ingress configuration model.

## Desired versus operational state

Desired state includes source/build settings, domains and ingress, environment
linkage, environment declarations, health checks, resources, replica count,
autoscaling policy, storage, placement, webhooks, and staging linkage.

Operational actions do not redefine desired state. Examples are waking a
sleeping app, restarting containers, rolling back a deployment, promoting
staging, migrating a replica, and recovering an engine operation.

## First and later deploys

The same request and engine path handles both. If the app does not exist, the
engine creates it from the stored manifest. If it exists, the engine stores the
new manifest and converges the app. There is no separate redeploy mental model.
