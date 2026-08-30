# Concepts

## Source desired state, immutable runtime

The app manifest owns both complete runtime configuration and a source/build
contract. `ocd deploy` builds the exact Git commit, obtains a registry digest,
and applies the whole manifest. Signed push webhooks do the same from the
committed manifest, so code and environment projections do not drift.

| Intent | Command |
| --- | --- |
| Validate desired state | `ocd manifest validate` |
| Build and reconcile an app | `ocd deploy` |
| Build and reconcile a stack | `ocd deploy stack` |
| Apply config with current digest | `ocd deploy --config-only` |
| Advanced artifact-only rollout | `ocd release <app> --image <repository@sha256:digest>` |
| Roll back exact history | `ocd rollback <app>` |

Build repositories use temporary tags only for publication. Runtime desired
state and deployment history always store digest-qualified image references.

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
operator-owned hosts support stateless workloads; managed provider volumes and
services require supported managed infrastructure.
