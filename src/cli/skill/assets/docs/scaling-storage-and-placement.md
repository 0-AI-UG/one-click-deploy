# Scaling, Storage, and Placement

## Desired scaling

Declare replicas and autoscaling in `.ocd-deploy.json`:

```json
{
  "replicas": 2,
  "autoscaling": {
    "enabled": true,
    "min_replicas": 1,
    "max_replicas": 6,
    "cpu_threshold": 70,
    "memory_threshold": 80,
    "request_threshold": 0,
    "cooldown_seconds": 300
  },
  "scale_to_zero_after": 900
}
```

Apply with `ocd deploy`. Inspect the stored policy with:

```bash
ocd scale policy show my-app
```

## Wake

Waking is an operational action:

```bash
ocd scale wake my-app
```

It starts a sleeping app without replacing the desired scaling policy.

## Placement

Persistent scheduling intent belongs in `placement_pool` and
`durability_class`. `ocd deploy --server=ID` is a one-deploy operational
override. Move an existing replica explicitly with:

```bash
ocd scale migrate my-app 42 --to=7
```

## Storage

Declare the primary `volume` and `extra_volumes` in the manifest. Use
`ocd volumes` and `ocd resources` for inspection and lifecycle operations that
are not app desired-configuration changes.
