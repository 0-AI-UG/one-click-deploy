# Build Workers and Webhooks

## Architecture

An OCD build worker is an empty dedicated server reserved from application
placement. It runs Docker BuildKit under OCD's SSH control; it is not registered
with GitHub Actions and consumes no Actions minutes.

For each build OCD:

1. clones the manifest's HTTPS repository into an operation-scoped directory;
2. checks out the exact requested commit in detached mode;
3. runs `docker buildx build` for each declared Dockerfile on the pinned
   `linux/amd64` platform, importing and exporting a per-image registry cache;
4. pushes a temporary commit tag to the declared OCI repository;
5. resolves and verifies the registry digest;
6. reconciles the committed manifest or stack using that digest;
7. removes checkout, temporary credentials, local images, and local build cache.

The immutable digest remains the deployment-history, rollback, promotion, and
runtime-attestation boundary.

The mutable cache reference is `<image_repository>:ocd-buildcache`. It uses the same scoped
registry connection and never becomes runtime identity. Add `"cache": false`
to a build manifest for a cold diagnostic build or an incompatible registry;
`"platform": "linux/amd64"` may be stated explicitly and is the only supported
runtime ABI today. Cache export errors are non-fatal and cannot replace digest
verification.

## Install a worker

Deploying a `build` manifest checks readiness first. When no worker exists it can reserve
an empty server or, after browser approval, provision and install a dedicated
worker before resuming the deploy. This can also be run explicitly:

```bash
ocd doctor
ocd runners bootstrap
```

For manual placement, the server must be ready and contain no panel or app:

```bash
ocd runners install --server=ocd-build-1 --name=ocd-build-1
ocd runners ls
```

When converting a legacy GitHub Actions runner, obtain a fresh removal token
once and provide it through an environment variable:

```bash
export GITHUB_RUNNER_REMOVE_TOKEN='...'
ocd runners install --server=ocd-build-1 \
  --removal-token-env=GITHUB_RUNNER_REMOVE_TOKEN
```

OCD deregisters and disables the old Actions runner before installing its own
worker. The token is held only for that operation.

## Credentials

OCD holds two distinct encrypted connections:

- `ocd source login`: host-scoped read access to private source repositories.
- `ocd registry login`: repository-namespace-scoped push/pull access.

The same actions are available as connection cards in Admin. Credentials are
never forwarded to an unrelated Git host or sibling OCI namespace.

Use the least privilege available. Never commit either credential. GitHub OAuth
login credentials are unrelated and are not reused for builds.

## Configure a push webhook

Deploy a build manifest once, then:

```bash
ocd runners sources
ocd runners webhook-secret <source-id>
```

In GitHub repository settings create a webhook with:

- Payload URL: the printed OCD URL;
- Content type: `application/json`;
- Secret: the value shown once;
- Events: push only;
- SSL verification: enabled.

OCD verifies `X-Hub-Signature-256`, repository identity, configured branch, and
the full pushed commit. Duplicate delivery of the same source/commit is
idempotent. A secret rotation invalidates the old value immediately.

## Failure and recovery

```bash
ocd runners ls
ocd runners sources
ocd ops
ocd ops logs <id> --follow
```

A failed build never changes desired runtime image or configuration. Fix the
source/build/credential problem and push a new commit, or retry the operation.
Removing a worker returns the server to its prior capacity pool; it does not
delete the VPS.

Workers are probed in parallel and require a fresh health observation, an amd64
architecture, and at least 12 GiB free. OCD holds a durable, heartbeated worker
lease plus a host `flock`; a lost lease fences publication. A disconnect or
timeout before any artifact is recorded is retried once on another worker.
After an artifact is recorded, recovery instead re-verifies every persisted
digest before it adopts the checkpoint.

Checkout is bounded to five minutes and each image build to 45 minutes.
Cancellation terminates the remote process group before cleanup. Newer webhook
deliveries supersede older work, late events are retained as stale without
running, and the configured branch head is checked again before reconciliation.

Treat build workers as trusted production infrastructure: repository
Dockerfiles execute code there and OCI push credentials are available only
during the operation. Do not point production webhooks at untrusted forks.
