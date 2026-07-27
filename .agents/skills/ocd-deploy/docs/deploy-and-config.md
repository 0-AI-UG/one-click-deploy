# Deployments, desired configuration, and provenance

## Contents

- [Choose the operation](#choose-the-operation)
- [Manifest apply behavior](#manifest-apply-behavior)
- [Configuration diff](#configuration-diff)
- [Environment behavior](#environment-behavior)
- [Configuration-only apply](#configuration-only-apply)
- [Code-only redeploy](#code-only-redeploy)
- [Revision and deployment history](#revision-and-deployment-history)
- [Settings changed in the UI](#settings-changed-in-the-ui)
- [Storage limitation](#storage-limitation)

## Choose the operation

Use this decision table:

| Intent | Command |
|---|---|
| Create an app from a manifest | `ocd deploy [manifest]` |
| Preview what a manifest would change | `ocd config diff [manifest]` |
| Make stored configuration match a manifest without code rollout | `ocd config apply [manifest]` |
| Apply manifest and deploy latest code | `ocd deploy [manifest]` |
| Repeat the stored source deployment while preserving UI/current config | `ocd redeploy <app>` |
| Load environment changes without a build | `ocd restart <app>` |
| Return to the prior successful commit | `ocd rollback <app>` |

## Manifest apply behavior

For an existing app, `ocd deploy` behaves as **apply desired configuration,
then enqueue code redeploy**. It is idempotent by app name; it does not attempt
to create a duplicate app.

The complete normalized specification covers:

- source mode; immutable image digest, or Git repository/branch/Dockerfile/build
  context; explicit registry-backed build cache;
- container port and linked environment projection;
- public/private state, domain when explicitly present, internal protocol,
  health checks, auth, sticky sessions, rate limit, IP allowlist, compression,
  and raw public port;
- memory, CPU, replica/scaling values, durability, placement, and bind mounts;
- webhook enablement, branch/path, CI waiting, and staging environment;
- manifest provenance.

Omitted manifest-controlled values normally normalize to their documented
defaults. Therefore, a manifest apply can intentionally replace UI-edited
settings with manifest/default values. Run `ocd config diff` first when drift is
possible.

Exceptions designed to protect durable state:

- omitted environment selection retains the app's current environment;
- omitted domain does not erase an existing/auto-managed domain;
- environment values already stored win over manifest defaults;
- persistent storage cannot be newly attached through config apply.

The app is locked against concurrent app operations while configuration is
applied. Ingress is synchronized after the apply.

## Configuration diff

```bash
ocd deploy [manifest] --dry-run
ocd config diff [manifest]
```

The diff compares normalized manifest intent to the stored app row and lists
field-level `before → after` values. It:

- performs no database/configuration writes;
- deploys no code;
- shows the current configuration revision;
- does not show secret values;
- reports “would create” when the app does not exist.

Environment payload contents are deliberately not emitted as a diff. Review
environment keys separately with `ocd envs show`.

## Environment behavior

When `--env` is supplied, link that existing environment. When omitted for an
existing app, retain the current link.

Manifest env-value precedence:

1. `--set`;
2. existing stored environment value;
3. manifest default;
4. prompt for a missing required value.

Incoming keys merge into the environment; unrelated stored keys remain. A
config apply never deletes an environment.

An environment edit advances every linked app's configuration revision. Use a
rollout mode on `ocd envs set/unset` to decide when containers receive it.

## Configuration-only apply

```bash
ocd deploy [manifest] --config-only
ocd config apply [manifest]
```

This requires an existing app. It writes desired configuration and manifest
provenance but does not build or recreate app containers. Ingress-only changes
are synchronized immediately; container-affecting changes become active on the
next restart/redeploy as appropriate.

The command returns the resulting configuration revision and field changes.

## Source-only redeploy

```bash
ocd redeploy <app>
```

Redeploy reads source identity, port, environment link, routing, resources,
scaling, health contract, and other configuration already stored on the app.
It does not read a local manifest and does not overwrite UI changes. In `git`
mode it clones/builds the configured branch. In `image` mode it re-pulls and
runs the exact stored digest; it never contacts Git.

Use this for:

- routine “deploy latest code” operations;
- redeploy after UI settings changes;
- avoiding accidental manifest reconciliation;
- deployments initiated outside the original repository checkout.

Webhook redeploys follow the same stored-configuration principle while pinning
the commit selected by the webhook event.

## Revision and deployment history

`config_revision` is monotonic per app. Database-level triggers advance it for
runtime/build field changes, including changes made through UI routes. Changes
to a linked environment's variables advance linked apps as well.

Every deployment-history record stores:

- image tag;
- actual immutable image digest when applicable;
- Git commit;
- status/source/log;
- configuration revision.

After an explicit manifest apply, the app also stores:

- `last_manifest_path`;
- `last_manifest_hash`;
- `last_manifest_applied_at`;
- `last_manifest_config_revision`.

When the current revision differs from the last manifest revision, the UI marks
the manifest as differing. This means desired configuration changed after the
apply; it does not automatically mean the change is wrong.

## Settings changed in the UI

UI edits are first-class desired configuration:

- “Deploy latest code” preserves them.
- “Save configuration & deploy” stores them and rolls out.
- A later explicit manifest apply may overwrite them.

For teams that want Git-reviewed configuration changes, use this workflow:

1. Inspect the UI/current revision.
2. Update the manifest to represent the desired result.
3. Run `ocd config diff`.
4. Review especially public exposure, resources, scaling, environment, and
   webhook changes.
5. Run `ocd deploy` or `ocd config apply`.

## Storage limitation

Creating a persistent cloud volume is not a normal configuration-row update.
For a new app, `volume` may provision one during the initial deployment saga.
For an existing app without a volume, manifest/config apply refuses to add it.
Use the Volumes UI to create/attach storage explicitly, then keep compatible
single-replica settings.
