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

Declare the primary `volume` and `extra_volumes` in the manifest. The primary
`volume` field is required: `null` means no attached volume, an object without
`id` means an OCD-managed volume, and an object with `id` adopts that exact
provider volume. `ocd deploy` is the only topology/size/path mutation path.

Use `ocd volumes` and `ocd resources` only to inspect volumes, browse files,
review deletion audit records, or permanently delete
an unused volume. The browser shows manifest intent and observed attachment as
separate read-only state; it has no volume controls.
