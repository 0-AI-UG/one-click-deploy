# Troubleshooting

## App is unhealthy but its URL works

```bash
ocd app show my-app
ocd app replicas my-app
ocd app availability my-app
ocd logs my-app --tail=200
ocd ops --app=my-app
```

Compare the configured health mode/path/command/file with the behavior inside
the container. Fix desired health configuration in `.ocd-deploy.json`, preview
it with `ocd deploy --dry-run`, then run `ocd deploy`.

## Sleeping app does not wake

```bash
ocd scale wake my-app
ocd ops --app=my-app
ocd app replicas my-app
ocd logs my-app --tail=200
```

Use wake for the immediate operational action. Fix replica/autoscaling or
scale-to-zero intent in the manifest and apply it with `ocd deploy`.

## Local and server configuration differ

```bash
ocd deploy --dry-run
```

The diff is local manifest versus stored desired manifest. If intentional,
apply with `ocd deploy` or `ocd deploy --config-only`.

## Environment not found

Manifest links use environment names, not IDs:

```bash
ocd envs list
```

Correct the manifest `environment`, then rerun deploy. Staging is an explicit
app with its own manifest and environment.

## Build or release cannot publish/pull an image

For a build, confirm the exact commit is pushed, the Git checkout token can
read the repository, Dockerfile/context paths are repository-relative, and the
OCI token can push. For an artifact-only release, confirm the complete
`repository@sha256:<digest>` exists. Fleet hosts must authenticate to and reach
the registry. Credentials are deliberately withheld when the image host differs
from Admin Settings. Inspect operation logs before retrying.

## Stuck operation

```bash
ocd ops
ocd ops <id>
ocd ops logs <id>
```

Only use cancel, retry, or finalize after inspecting the operation and with
explicit user intent.
