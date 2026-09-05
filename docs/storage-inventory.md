# Storage inventory

Infrastructure → Volumes and `ocd volumes` list provider block volumes. A
successful provider inventory is authoritative; stale retirement records for
missing disks do not appear as billable volumes.

Server-local persistent directories appear in the server's Storage section,
including retained directories, and in the owning app's Storage section.
The CLI equivalents are:

```sh
ocd servers show <name|id> --storage
ocd app show <app> --storage
```

Local directories share the server disk and have no separate storage charge.
Their configured size is not reserved capacity or an enforced quota, so the
UI does not display it as capacity. Directory usage is measured on the host,
cached for up to one minute, and shown as unavailable when inspection fails.
The server's disk metrics show overall space available to its workloads.

This changes inventory presentation only; it does not move data, change
mounts, resize storage, or delete resources.
