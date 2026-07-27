---
name: ocd-deploy
description: Deploy, configure, operate, recover, and troubleshoot apps, stacks, environments, managed services, networking, storage, scaling, webhooks, and engine operations on One-Click Deploy (OCD), a self-hosted Hetzner PaaS. Use for `.ocd-deploy.json`, `ocd-stack.json`, every `ocd` CLI command, OCD panel behavior, desired-configuration changes, code-only redeploys, staging promotion, destructive-action confirmation, retained environments or volumes, and OCD deployment incidents.
---

# Deploy and operate with OCD

Use this skill as the operational source of truth for OCD. Do not infer behavior
from Heroku, Railway, Docker Compose, or Kubernetes: OCD has its own ownership,
configuration, rollout, and recovery semantics.

## Core mental model

- Treat Git as the source of application code.
- Treat OCD's database as the source of desired runtime configuration.
- Treat a manifest as a complete configuration input that is applied only by an
  explicit manifest operation.
- Use `ocd deploy` to apply a manifest and then build/deploy Git code.
- Use `ocd redeploy` to build/deploy the latest configured Git branch with the
  configuration already stored in OCD. It does not reread a manifest.
- Use `ocd config diff` to preview a manifest against stored configuration.
- Use `ocd config apply` to apply manifest configuration without deploying code.
- Expect UI edits and environment edits to update stored configuration. A later
  code-only redeploy preserves them.
- Expect a later manifest apply to reconcile the complete manifest-controlled
  specification. Review the diff when UI and manifest values may have diverged.

Read [docs/concepts.md](docs/concepts.md) before changing deployment behavior
or explaining configuration ownership.

## Mandatory working method

1. Inspect the repo, Git remote, Dockerfile, build context, listening port,
   health endpoint, runtime variables, persistent paths, and dependency graph.
2. Identify whether the target is one app, a stack, or a standalone managed
   service.
3. Read the relevant documentation file from the routing table below. For
   manifest or CLI work, always read the exact field/command reference rather
   than relying on memory.
4. Start from the closest file under [examples/](examples/) and adapt it.
5. Keep secrets out of Git and avoid printing them in commands, logs, or output.
6. Run the requested CLI operation and follow its engine operation until it is
   terminal.
7. Verify current resources with `ocd status`, `ocd apps`, or
   `ocd stack status <name>`. Do not equate the last operation result with
   current resource health.

Install and authenticate:

```bash
curl -fsSL https://ocd.cero-ai.com/cli/install.sh | sh
ocd login https://ocd.cero-ai.com
```

## Documentation routing

Read only the files relevant to the task, but read each selected file fully.

| Task | Required documentation |
|---|---|
| Understand config ownership, revisions, deploy vs redeploy | [docs/concepts.md](docs/concepts.md), [docs/deploy-and-config.md](docs/deploy-and-config.md) |
| Author or review `.ocd-deploy.json` | [docs/app-manifest.md](docs/app-manifest.md) |
| Author or review `ocd-stack.json` | [docs/stack-manifest.md](docs/stack-manifest.md), [docs/stacks-and-services.md](docs/stacks-and-services.md) |
| Use any CLI command or flag | [docs/cli-reference.md](docs/cli-reference.md) |
| Manage variables, secrets, or environment rollouts | [docs/environments-and-secrets.md](docs/environments-and-secrets.md) |
| Configure domains, private URLs, protocols, auth, or raw ports | [docs/networking-and-ingress.md](docs/networking-and-ingress.md) |
| Configure replicas, durability, placement, or volumes | [docs/scaling-storage-and-placement.md](docs/scaling-storage-and-placement.md) |
| Configure webhooks, staging, or promotion | [docs/webhooks-and-promotion.md](docs/webhooks-and-promotion.md) |
| Inspect, cancel, retry, finalize, or recover operations | [docs/operations-and-recovery.md](docs/operations-and-recovery.md) |
| Delete anything or assess retention/confirmation | [docs/security-and-deletion.md](docs/security-and-deletion.md) |
| Diagnose a failure or stale state | [docs/troubleshooting.md](docs/troubleshooting.md) |

The compatibility [reference.md](reference.md) is only an index into these
files; detailed truth lives under `docs/`.

## Non-negotiable safety invariants

- Never delete an environment as a side effect of deleting an app or stack.
- Require OCD web UI approval for every environment deletion and every stack
  deletion. `--yes` must not bypass either action.
- Permit app deletion automation only when the user explicitly authorized
  `--yes`; otherwise use browser confirmation.
- Treat `ocd ops cancel` as destructive because compensation can remove
  resources created by the operation.
- Treat stack reconciliation as destructive when members were removed from the
  manifest: omitted recorded members are destroyed.
- Treat volumes as billable even after detachment. OCD retains managed volumes
  for recovery; retention is not deletion.
- Never invent a managed-service type or version. Query
  `ocd service catalog`.
- Never commit basic-auth passwords or required secrets. Use a local
  environment variable, hidden prompt, or explicit environment operation.
- Do not add a persistent volume to an existing app through manifest apply.
  Attach storage explicitly in the UI first.

## Fast command map

```bash
ocd status
ocd apps
ocd deploy [manifest]
ocd deploy --dry-run
ocd config diff [manifest]
ocd config apply [manifest]
ocd redeploy <app>
ocd deploy stack [manifest]
ocd stack status <name>
ocd service catalog
ocd envs show <environment>
ocd ops logs <id> --follow
```

Use [docs/cli-reference.md](docs/cli-reference.md) for complete syntax, aliases,
flags, defaults, confirmation behavior, and command outcomes.
