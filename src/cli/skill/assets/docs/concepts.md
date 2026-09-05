# Concepts

## Source desired state, immutable runtime

The app manifest owns complete runtime configuration and exactly one delivery
source. A `build` source builds the exact Git commit and publishes it to
`build.image_repository`; an `image` source resolves a prebuilt tag or digest
without a build worker. Both paths apply the whole manifest and store only an
immutable runtime digest. Signed push webhooks apply only to build sources.

| Intent | Command |
| --- | --- |
| Validate desired state | `ocd manifest validate` |
| Reconcile an app from its declared source | `ocd deploy` |
| Reconcile a stack from member sources | `ocd deploy stack` |
| Apply config with current digest | `ocd deploy --config-only` |
| Advanced artifact-only rollout | `ocd release <app> --image <repository@sha256:digest>` |
| Roll back exact history | `ocd rollback <app>` |

Build repositories use temporary tags only for publication. Prebuilt image
tags are resolved before deployment. Runtime desired state and deployment
history always store digest-qualified image references.

A manifest catalog is just version-controlled app manifests. It has no
separate server-side lifecycle: catalog entries deploy as standalone apps or
stack members.

## Environments and staging

An environment is a named variable/secret bag. A stack member's projection
limits which keys it receives. Webhook delivery reads committed manifests, so
projection changes are applied with the image built from that commit.

Staging is an explicit app or stack target with its own environment and domain.
Promotion copies an exact tested digest; it does not rebuild.

## Provider boundaries

Source checkout accepts compatible HTTPS Git hosts. Image publication accepts
compatible OCI registries such as GHCR, GitLab, Docker Hub, Quay, Harbor, and
self-hosted registries. GitHub signed push webhooks are the current automatic
source trigger; manual deployment is not GitHub-dependent.

DNS is manual and provider-neutral. Hetzner provisioning is optional. Connected
operator-owned hosts support stateless workloads and server-local persistent
directories. Provider block volumes require supported managed infrastructure.
Local directories share the host disk and are shown in app/server Storage,
separately from the provider Volumes inventory.
