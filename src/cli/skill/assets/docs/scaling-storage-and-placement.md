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
    "requests_per_minute": 0,
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

The default driver depends on server ownership and the assigned infrastructure
provider. A compatible managed provider host prefers provider block storage;
otherwise OCD selects server-local storage. Inspect the actual driver and mount
instead of inferring it from the server's location or a manifest size.
Server-local directories live under `/var/lib/ocd/volumes`; they survive
container replacement but share the host disk, have no separate storage charge,
and have no reserved capacity or enforced quota. Changing their configured size
does not allocate disk. They and explicit host mounts cannot be migrated to
another server through replica migration.

### Inventory and disk usage

- Infrastructure → Volumes and `ocd volumes` list provider block volumes only,
  with capacity, attachment and estimated provider cost. A successful provider
  listing excludes stale records for disks that no longer exist.
- App → Storage and `ocd app show <app> --storage` show persistent mounts and
  measured usage; the CLI also shows image storage.
- Server → Storage and `ocd servers show <name|id> --storage` show server-local
  directories, including retained directories, alongside the server's disk metrics.

Local entries show host, path, usage, and “shares server disk · no separate
storage charge”. Usage is cached for up to one minute; failed inspection shows
unavailable, not zero. The requested manifest size is not displayed as local
capacity. Inspect server free space because images and other workloads share it.

### PostgreSQL placement

Verify `SHOW data_directory` and its mount after deploying or consolidating a
database. A host directory is persistent across containers but does not provide
an independently detachable provider disk. Preserve the requested storage type
when migrating; choosing a separate provider volume requires a compatible driver
and confirmation of the actual provider attachment.

OCD caps apps with a primary volume at one replica. Raising `replicas` does not
configure PostgreSQL replication. Database replication needs separate data
stores and database-aware orchestration; introduce it when availability or read
load requirements justify the additional operations.
