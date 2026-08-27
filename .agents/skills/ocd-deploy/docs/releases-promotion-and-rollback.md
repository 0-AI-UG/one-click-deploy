# Releases, Promotion, and Rollback

## CI release contract

CI owns building and publishing. OCD needs only the panel URL, a CI-scoped
token, the target app, and the exact registry digest:

```bash
export OCD_PANEL_URL=https://panel.example.com
export OCD_TOKEN="$OCD_CI_TOKEN"

ocd release api \
  --image "ghcr.io/example/api@sha256:${IMAGE_DIGEST#sha256:}" \
  --commit "$GITHUB_SHA" \
  --idempotency-key "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
```

`OCD_PANEL_URL` and `OCD_TOKEN` must be supplied together. Store the token as a
protected CI secret and give it only the permissions needed to release the
target app. The optional commit is provenance metadata. The idempotency key
makes CI retries attach to the same release; GitHub run identifiers are used
automatically when the flag is omitted.

`ocd release` requires an existing app. Create it once with a digest manifest.
The release endpoint preserves the stored environment, ingress, storage,
resources, placement, and health configuration. It commits the new digest only
after the candidate becomes healthy.

The registry login used by this workflow pushes the artifact from CI. For a
private image, configure OCD's separate fleet pull credential under panel
**Settings → Defaults → OCI repository**; see
[Immutable images and health](immutable-images-and-health.md#private-registry-pulls).

## GitHub Actions example

The image publishing action exposes a registry digest. Pass that output—not a
tag—to OCD:

```yaml
permissions:
  contents: read
  packages: write

steps:
  - uses: actions/checkout@v4
  - uses: docker/login-action@v3
    with:
      registry: ghcr.io
      username: ${{ github.actor }}
      password: ${{ secrets.GITHUB_TOKEN }}
  - id: publish
    uses: docker/build-push-action@v6
    with:
      push: true
      tags: ghcr.io/example/api:${{ github.sha }}
  - name: Release exact digest
    env:
      OCD_PANEL_URL: ${{ secrets.OCD_PANEL_URL }}
      OCD_TOKEN: ${{ secrets.OCD_TOKEN }}
      IMAGE_REF: ghcr.io/example/api@${{ steps.publish.outputs.digest }}
    run: ocd release api --image "$IMAGE_REF" --commit "$GITHUB_SHA"
```

Install a pinned OCD CLI version in the job before the release step according
to your organization’s runner policy.

## Staging semantics

Staging and production are explicit, independently configured apps—for example
`api-staging` and `api`. Each has its own manifest, environment, domain, and
deployment history. A production deploy or release never creates the staging
app. Create it once from its own digest manifest:

```bash
ocd deploy path/to/api-staging.ocd-deploy.json
```

CI then releases a candidate to staging by name:

```bash
ocd release api-staging --image "$IMAGE_REF" --commit "$GITHUB_SHA"
```

After validation, promote the exact deployed staging digest:

```bash
ocd promote --from=api-staging --to=api
```

Promotion requires browser approval. It does not rebuild, follow a tag, or
copy staging configuration and secrets. The destination keeps its own stored
configuration and rolls out the source app's exact successful digest.

For stacks, `staging_environment` selects an already existing environment and
`staging_env` applies explicit values to it. Those fields do not create
staging apps, release images, or create staging managed services. Deploy each
staging app explicitly before using app-to-app promotion.

## Exact rollback

Inspect history, then select a known successful deployment:

```bash
ocd app deployments api
ocd rollback api --deployment=123
```

Omitting `--deployment` chooses the previous successful deployed record:

```bash
ocd rollback api
```

Rollback reuses the stored digest and configuration snapshot for that
deployment. It does not rebuild an older commit. State the target deployment
explicitly when reproducibility matters.
