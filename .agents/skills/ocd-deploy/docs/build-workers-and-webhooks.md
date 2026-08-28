# Build Workers and Webhooks

## Architecture

An OCD build worker is an empty dedicated server reserved from application
placement. It runs Docker BuildKit under OCD's SSH control; it is not registered
with GitHub Actions and consumes no Actions minutes.

For each build OCD:

1. clones the manifest's HTTPS repository into an operation-scoped directory;
2. checks out the exact requested commit in detached mode;
3. runs `docker buildx build` for each declared Dockerfile on `linux/amd64`;
4. pushes a temporary commit tag to the declared OCI repository;
5. resolves and verifies the registry digest;
6. reconciles the committed manifest or stack using that digest;
7. removes checkout, temporary credentials, images, and build cache.

The immutable digest remains the deployment-history, rollback, promotion, and
runtime-attestation boundary.

## Install a worker

The server must be ready and contain no panel, app, or managed service:

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

Admin Settings holds two distinct credential sets:

- Git checkout username/token: read access to private source repositories.
- OCI repository username/password-token: push during builds and pull during
  deployments. The configured repository host scopes where it may be sent.

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

Treat build workers as trusted production infrastructure: repository
Dockerfiles execute code there and OCI push credentials are available only
during the operation. Do not point production webhooks at untrusted forks.
