# GitHub Actions Build Runners

OCD can install GitHub's official self-hosted Actions runner on an empty,
dedicated server. The runner checks out source, builds the container, pushes it
to an OCI registry, then asks OCD to apply the committed desired configuration
with that immutable digest. OCD itself still never checks out source or builds
an image.

Jobs executed on a standard self-hosted runner do not consume GitHub-hosted
Actions minutes. You still pay for the VPS and any registry storage or network
usage. Check GitHub's current [Actions billing
documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
before relying on this for cost planning.

## Security boundary

A workflow has the same power as root on the runner host: the runner user is in
the Docker group. It can also reach networks available to that VPS. Therefore:

- use a server dedicated to one trusted organization or repository;
- use only private repositories and trusted branches/workflows;
- never run workflows from untrusted fork pull requests on this runner;
- for an organization runner, restrict its runner group to the repositories
  that actually need it;
- keep production release credentials in a protected GitHub environment;
- do not install apps, managed services, or the OCD panel on the runner host.

OCD enforces the last rule at installation time and reserves the server in the
`build-runners` pool. App and managed-service schedulers exclude it. This is
workload isolation, not a sandbox for hostile code.

## Install

Start with a ready server that has no panel, apps, or managed services. It may
be an OCD-managed Hetzner server or a manually connected VPS.

In GitHub, open the organization or repository **Settings → Actions → Runners**
and create a new self-hosted runner. Copy the one-hour registration token, then
pass it through an environment variable so it does not enter shell history:

```bash
export GITHUB_RUNNER_TOKEN='github-one-hour-registration-token'
ocd runners install \
  --server=ocd-build-1 \
  --scope=https://github.com/OWNER
unset GITHUB_RUNNER_TOKEN
```

Use a repository URL such as `https://github.com/OWNER/REPO` instead of the
organization URL to register a repository-only runner. The Admin panel exposes
the same installation flow.

OCD downloads a checksum-pinned official runner archive, creates the
unprivileged `ocd-runner` account, installs `ocd-github-runner.service`, and
adds the fixed `ocd-builder` label. The one-hour token is encrypted only while
the durable operation runs and is deleted afterwards.

Inspect it with:

```bash
ocd runners ls
ocd runners logs ocd-build-1 --tail=200
```

One runner processes one job at a time. Add another dedicated server and
runner when parallel builds are required.

## Automatic build and deploy workflow

The following pattern builds every commit pushed to `main`, pushes its
immutable artifact to GHCR, and applies the committed manifest with that exact
digest. Store
`OCD_PANEL_URL` and `OCD_TOKEN` as secrets in a protected `production`
environment. Store the SHA-256 of the panel-provided Linux x64 CLI as the
environment variable `OCD_CLI_LINUX_X64_SHA256`.

```yaml
name: Build and deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

jobs:
  build-and-deploy:
    runs-on: [self-hosted, ocd-builder]
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/owner/app:${{ github.sha }}
      - name: Install verified OCD CLI
        env:
          OCD_PANEL_URL: ${{ secrets.OCD_PANEL_URL }}
          OCD_CLI_SHA256: ${{ vars.OCD_CLI_LINUX_X64_SHA256 }}
        run: |
          test -n "$OCD_CLI_SHA256"
          curl -fsS "$OCD_PANEL_URL/cli/ocd-linux-x64" -o /tmp/ocd
          printf '%s  %s\n' "$OCD_CLI_SHA256" /tmp/ocd | sha256sum -c -
          chmod 0755 /tmp/ocd
      - name: Apply config and exact digest
        env:
          OCD_PANEL_URL: ${{ secrets.OCD_PANEL_URL }}
          OCD_TOKEN: ${{ secrets.OCD_TOKEN }}
          IMAGE_REF: ghcr.io/owner/app@${{ steps.image.outputs.digest }}
        run: |
          /tmp/ocd deploy .ocd-deploy.json \
            --image "$IMAGE_REF" \
            --commit "$GITHUB_SHA"
```

Keep a different build context or Dockerfile path in the workflow when the app
lives in a monorepo. The deploy must always use the digest emitted by the
registry push, never a mutable tag. `--image` changes the parsed manifest only
in memory, so generated digests do not need to be committed.

For a stack, build every changed member first and pass all resulting digests in
one desired-state reconciliation:

```bash
/tmp/ocd deploy stack ocd-stack.json \
  --image=web="$WEB_IMAGE_REF" \
  --image=worker="$WORKER_IMAGE_REF" \
  --commit="$GITHUB_SHA"
```

This is important when a commit changes environment projections, health
checks, resources, or other manifest settings. `ocd release` is deliberately
image-only: use it only when the stored configuration is already correct and
the artifact is the sole desired change.

OCD runs a post-job Docker prune for build cache and images older than 24
hours. Monitor free disk with `ocd runners ls`; size the VPS for the largest
concurrent build rather than only for the resulting image.

## Remove

Obtain a fresh removal token from the same GitHub runner settings page, then:

```bash
export GITHUB_RUNNER_REMOVE_TOKEN='github-one-hour-removal-token'
ocd runners remove ocd-build-1
unset GITHUB_RUNNER_REMOVE_TOKEN
```

Removal is fail-closed: OCD first deregisters the runner at GitHub, removes the
service and files, then restores the server's previous placement pool. The VPS
is retained. If GitHub already lost the runner record, remove it in GitHub and
use a newly issued removal token before retrying the OCD operation.
