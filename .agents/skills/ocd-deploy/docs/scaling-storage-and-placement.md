# Scaling, storage, durability, and placement

## Contents

- [Replica model](#replica-model)
- [Durability classes](#durability-classes)
- [Placement pools](#placement-pools)
- [Manual and automatic scaling](#manual-and-automatic-scaling)
- [Scale to zero](#scale-to-zero)
- [Managed app volumes](#managed-app-volumes)
- [Extra bind mounts](#extra-bind-mounts)
- [Retention and recovery](#retention-and-recovery)

## Replica model

OCD stores desired, minimum, and maximum replica counts. The reconciler
converges actual replicas on ready servers. Manual scaling is level-triggered:
the desired count changes, then the reconciler normally converges within its
next ticks.

Public HTTP ingress load-balances replicas over the private network. A custom
domain is not required for multiple replicas.

## Durability classes

Manifest `durability_class` maps to concrete floors:

| Class | Maximum per host | Minimum locations | Minimum replicas |
|---|---:|---:|---:|
| `none` | unlimited (`0`) | 1 | 1 |
| `standard` | 1 | 1 | 2 |
| `high` | 1 | 2 | 2 |

The requested `replicas` value is raised to the class minimum. `high` requires
capacity across at least two locations; `standard` spreads replicas across
hosts but not necessarily locations.

Availability sampling and placement enforce the concrete stored policy, not
the display label alone.

## Placement pools

Every server belongs to a named pool; default is `general`. Manifest
`placement_pool` restricts app replicas to that pool.

Use placement pools for portable, declarative scheduling. Use
`ocd deploy --server=<id>` only for a one-run standalone operational override:
server IDs are panel-local and unsuitable for committed manifests.

When adding a replica, OCD prefers eligible ready capacity while respecting
per-host and location spread. It may provision capacity when permitted and no
eligible ready server exists.

## Manual and automatic scaling

Use `ocd scale <app> <count>` or `ocd scale wake <app>`. An app with an
attached cloud volume cannot scale above one.

`ocd scale policy show/set` manages:

- enabled/disabled;
- minimum and maximum replicas;
- CPU threshold as percent of the app's CPU limit;
- memory threshold as percent of its memory limit;
- HTTP requests/minute per replica (HTTP apps only; zero disables);
- cooldown;
- scale-to-zero idle delay.

The reconciler evaluates metrics about every 30 seconds. CPU, memory, and
request signals compete; the signal demanding the greater replica count wins,
bounded by min/max and durability/storage constraints.

Manifest apply controls initial replicas, durability, placement, and
`scale_to_zero_after`; the narrow policy command changes thresholds without
rereading a manifest. Use `ocd scale migrate ... --to=<server>` for exact
replica placement.

## Scale to zero

Minimum replicas `0` allows sleeping. `scale_to_zero_after` is the idle delay.

- A public HTTP app can wake on an incoming HTTP request through the panel.
- A private app has no public wake page; wake it through the dashboard/API or a
  scaling action.
- A sleeping app may retain a stopped anchor row while having zero running
  replicas.
- Pause/unpause and sleep/wake are distinct lifecycle concepts.

Confirm before manually scaling the last running replica to zero.

## Managed app volumes

A new app manifest may declare one managed cloud volume:

```json
{
  "volume": {
    "size": 20,
    "path": "/data"
  }
}
```

Constraints:

- a cloud volume attaches to one server at a time;
- the app is locked to one replica;
- default mount path is `/data`;
- adding a volume to an existing volume-less app through manifest/config apply
  is refused;
- use `ocd volumes attach/adopt/detach/reattach/resize/rename` for lifecycle
  operations.

An existing provider volume attached through “attach existing” is treated as
pre-existing data and is never provider-deleted by app destruction.

## Extra bind mounts

`extra_volumes` maps absolute host paths to absolute container paths. These are
host-local bind mounts, not portable managed cloud volumes. They can make
replica placement host-dependent and should be used only when the target pool
guarantees compatible paths/data.

## Retention and recovery

Destroying an app or service:

- detaches its managed volume;
- records OCD-created volumes in the retained/retired volume registry;
- preserves pre-existing attached volumes;
- does not automatically delete provider data.

The retained record has a seven-day **review date**, not an automatic deletion
deadline. Detached volumes remain billable.

Recover with `ocd volumes adopt`/`reattach`. Inspect with `volumes show/ls/cat`.
Permanent delete always requires browser approval and typing the provider ID.
`ocd volumes rename <id> <name>` changes provider metadata only.
`ocd volumes audit` shows the durable deletion ledger. OCD writes a pending
row before calling the provider, then records completion or failure with actor,
former owner, retention state, dates, and error.
