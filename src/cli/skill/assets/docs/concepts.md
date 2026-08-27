# Concepts

## Configuration and releases are separate

Each app has one server-side desired manifest. A local `.ocd-deploy.json` is a
complete declaration, not a patch. It includes an exact OCI image digest for
first creation. `ocd deploy` validates the manifest, resolves names and secret
inputs, then converges the app without building an image.

Later image delivery is a release, not a configuration rewrite:

| Intent | Command |
| --- | --- |
| Preview local versus stored configuration | `ocd deploy --dry-run` |
| Create an app or apply complete configuration | `ocd deploy` |
| Apply configuration while retaining the deployed image | `ocd deploy --config-only` |
| Release one externally built digest | `ocd release <app> --image <repository@sha256:digest>` |
| Copy one deployed digest between apps | `ocd promote --from=<source> --to=<destination>` |
| Restore a successful deployment | `ocd rollback <app> [--deployment=<id>]` |

The web UI renders manifest-owned configuration read-only. Operational actions
such as restart, rollback, pause, wake, promotion, replica migration, and
operation recovery do not redefine desired configuration.

## Immutable artifact rule

OCD accepts only `repository@sha256:<64 hex digest>`. Tags are mutable and are
rejected. The registry may be GitHub Container Registry or any other OCI
registry reachable by the fleet. CI owns source checkout, testing, building,
publishing, and push authentication. OCD owns pulling the selected digest,
health validation, rollout, and deployment history. Public pulls require no
configuration; private pulls use the fleet credential configured in panel
Settings for one explicitly configured repository host.

## Explicit staging targets

Staging is an ordinary, separately deployed app such as `api-staging`; it has
its own manifest, environment, domain, and deployment history. OCD does not
create a hidden staging app from a production manifest or release. Release the
candidate to that explicit app and promote its deployed digest with
`ocd promote --from=api-staging --to=api`.

## Provider boundaries

DNS remains at the operator's chosen provider; OCD only reports required
records. Hetzner credentials are optional and are used only for managed
infrastructure. Existing stateless Docker hosts can be enrolled instead.
