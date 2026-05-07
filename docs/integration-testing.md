# Integration Testing

Two test suites hit real Hetzner Cloud. Both are skipped by default and gated
on environment variables.

| Suite | File | Scope |
|-------|------|-------|
| Provider | `src/integration/hetzner.test.ts` | Raw Hetzner API (server, volume, network, firewall, SSH key). |
| Engine ops | `src/integration/engine-ops.test.ts` | End-to-end engine operations against one shared CX22. |

## Required environment variables

| Variable | Used by | Value |
|----------|---------|-------|
| `RUN_INTEGRATION=1` | both | Enables the suite. |
| `HCLOUD_TOKEN` | both | Hetzner Cloud API token (read-write). |
| `OCD_TEST_DNS_ZONE` | engine-ops | Throwaway zone, e.g. `itest.example.com`. |
| `OCD_TEST_GIT_REPO` | engine-ops | Clone URL of the fixture repo (see below). |

DNS credentials are read from the same settings keys the panel uses in
production (see `src/shared/db/settings*`). The engine-ops suite seeds those
keys from the same env vars.

## Fixture Git repo (one-time setup)

The `deploy` op clones a real repo. The minimal fixture lives at
`test/fixtures/hello-app/` in this repo.

1. Create a new public GitHub repo, e.g. `ocd-test-fixture`.
2. Copy `test/fixtures/hello-app/{Dockerfile,index.html}` into it and push.
3. `export OCD_TEST_GIT_REPO=https://github.com/<you>/ocd-test-fixture.git`

The image listens on port 8080 and returns `hello from ocd-itest`.

## DNS zone (one-time setup)

1. Pick a subdomain you control, e.g. `itest.example.com`.
2. Configure it with the DNS provider the panel already supports.
3. `export OCD_TEST_DNS_ZONE=itest.example.com`

The suite creates records under `app-<tag>.$OCD_TEST_DNS_ZONE` and removes
them in `afterAll`.

## Running

```bash
# Provider suite (~5 min, ~€0.002):
bun run test:integration

# Engine ops suite (~15-20 min, ~€0.02 per run):
bun run test:integration:engine
```

Resources provisioned by either suite are prefixed `ocd-itest-<tag>` so leaks
are easy to spot in the Hetzner Cloud console.

## Cleanup after a crash

If the suite crashes mid-run, some resources may leak. Find them in the
Hetzner console by filtering on `ocd-itest-` and delete manually:

- Servers
- Volumes (detach first if still attached)
- SSH keys
- Firewalls (the suite reuses the shared firewall — don't delete that one)
- DNS records under `$OCD_TEST_DNS_ZONE`

Cost of leaked resources is ~€0.006/hour per CX22 plus ~€0.04/month per 10 GB
volume. Clean up promptly.
