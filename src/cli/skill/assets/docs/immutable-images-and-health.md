# Immutable Images and Health

## Artifact boundary

OCD consumes OCI artifacts created elsewhere. The delivery system that owns
the source repository must test, build, scan as required, push to a registry,
and expose the registry-produced digest. OCD receives only the immutable
reference:

```text
ghcr.io/example/api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Mutable tags are unsuitable because the bytes behind them can change without a
new OCD deployment record. A tag may be published for humans, but pass the
digest to OCD.

## Private registry pulls

Public images need no credential. For private images, an OCD administrator
opens panel **Settings → Defaults** and configures:

- **OCI repository**, for example `ghcr.io/acme/apps`;
- **OCI registry username**;
- **OCI registry password/token**, with pull access.

The password/token is stored in the panel secret store and returned masked in
settings reads. At rollout time OCD compares the image registry host with the
configured repository host. Matching images receive the configured pull
credential; images on any other host are pulled without it. In the current
configuration model there is one private-registry credential set, so images
from a second private host require an administrator to change the setting.

This is separate from the CI credential used to push an image and separate
from `OCD_TOKEN`, which authorizes the release API. Never put registry
credentials in `.ocd-deploy.json`, `image.ref`, or command output.

## Candidate lifecycle

For `ocd deploy` and `ocd release`, OCD pulls the selected digest, starts the
candidate with stored desired configuration, evaluates readiness, and makes it
current only after success. A failed candidate does not become the app's
desired image.

Use `ocd app deployments <app>` to inspect the immutable digest recorded for
each attempt.

## Readiness modes

- `http`: request `health_check.path` and accept only
  `health_check.expected_statuses` (default `[200]`).
- `container`: require the container to remain running.
- `exec`: run `health_check.command`; exit zero is ready.
- `heartbeat`: require `health_check.file` to be newer than
  `health_check.max_age_seconds`.
- `periodic_job`: use the same marker-age contract for recurring work.

For a background worker with no HTTP listener, choose an explicit non-HTTP
mode. Do not weaken readiness merely to force a release through; first inspect
the candidate logs and health contract.

## Failure handling

```bash
ocd app deployments my-app
ocd logs my-app --tail=200
ocd ops --app=my-app
```

Fix the external artifact or desired health configuration, publish a new
digest when bytes changed, and release that digest. Never overwrite an
existing digest or retry through a mutable tag.
