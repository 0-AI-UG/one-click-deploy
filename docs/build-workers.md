# Build Worker Operations

OCD builds source repositories on dedicated, operator-controlled servers. It
does not register those servers with GitHub Actions. GitHub is only a source of
signed push events; the OCD engine schedules and supervises all build work.

## Delivery contract

Every delivery follows the same identity chain:

1. accept an exact 40- or 64-character Git commit;
2. lease one healthy `linux/amd64` worker;
3. check out that commit in detached mode;
4. build and push an operation-specific mutable tag;
5. read the registry-produced digest and verify it through the registry;
6. persist `repository + commit + target + digest` before reconciliation;
7. deploy only `repository@sha256:digest`.

Mutable tags and the `:ocd-buildcache` reference are transport state. Neither
may be used for runtime identity, rollback, promotion, or recovery.

## Scheduling and capacity

The engine probes all eligible workers concurrently. A worker must be ready,
online, not draining, `x86_64`/`amd64`, observed within 60 seconds, and have at
least 12 GiB free on `/`. Candidates prefer source affinity, then free disk,
least-recent use, and stable worker ID order.

One durable database lease owns slot zero on a worker. The lease lasts 120
seconds and is heartbeated every 20 seconds. The engine fences the result before
publication and releases the lease on exit; an expired or replaced token cannot
publish. A host-level `flock` is a second exclusion boundary if two engine
processes race or database state is stale.

## Build cache and platform

The supported runtime platform is explicitly `linux/amd64`. A manifest may
state it or omit it for the same default:

```json
{
  "build": {
    "repository": "https://github.com/acme/api.git",
    "dockerfile": "Dockerfile",
    "context": ".",
    "image": "registry.example/acme/api",
    "platform": "linux/amd64",
    "cache": true
  }
}
```

BuildKit imports and exports a per-image cache at
`registry.example/acme/api:ocd-buildcache`. The cache uses the same
repository-scoped credentials as the image push. Set `"cache": false` for a
diagnostic cold build or for a registry that cannot store BuildKit cache
manifests. Cache export errors are non-fatal. A missing, failed, or poisoned
cache cannot change the deployed identity: BuildKit still builds, the registry
digest is verified, and only that digest is persisted.

## Failure and recovery behavior

- Checkout timeout: 5 minutes.
- Per-target build timeout: 45 minutes, with a log heartbeat every 30 seconds.
- Disconnect or timeout before any artifact is recorded: retry once on a
  different worker.
- Failure after the first artifact is recorded: do not replay the multi-target
  build automatically; recover by verifying all persisted digests.
- Engine restart: adopt a build checkpoint only after every digest remains
  reachable from the registry.
- Cancel or timeout: terminate the remote process group, remove the operation
  checkout and ephemeral credentials, then prune under the host lock.
- Newer webhook event: cancel/supersede older queued or active delivery work.
- Late event: record it as stale and do not enqueue it.
- Branch changed during a build: reject the result before reconciliation.

The newest 100 terminal webhook deliveries per source are retained in addition
to all active deliveries.

## Operator checks

```bash
ocd doctor
ocd runners ls
ocd runners sources
ocd ops
ocd ops logs <operation-id> --follow
```

When a build is waiting, check in this order:

1. at least one worker is online and has 12 GiB free;
2. no long-running operation owns its lease;
3. source credentials cover the exact Git host;
4. registry credentials cover every target repository namespace;
5. the registry accepts both the image push and BuildKit cache media types;
6. the pushed commit is still the configured branch head for webhook builds.

Removing a worker returns the server to its previous placement pool; it does not
delete an operator-owned VPS. Treat all workers as trusted production hosts:
repository Dockerfiles execute code and receive scoped push credentials during
their operation.

## Test coverage

Unit and operation tests cover command construction, manifest validation,
parallel health probes, capacity leases and fencing, failover boundaries,
artifact checkpoints/recovery, cancellation, webhook ordering, and delivery
compaction. CI also starts a local OCI registry and runs real BuildKit pushes to
verify `linux/amd64`, cache export/import, digest extraction, and immutable
digest inspection. Provider provisioning remains in the explicitly opted-in
Hetzner integration suite.
