# Webhooks and Promotion

## Configure through the manifest

```json
{
  "webhook": {
    "enabled": true,
    "branch": "main",
    "path": "",
    "wait_for_ci": true,
    "staging": true,
    "staging_environment": "staging"
  }
}
```

`staging_environment` is an environment name or `null`. A name enables staging
and links that environment. When `staging` is true and no name is provided, the
deploy engine may create the conventional staging environment.

Apply or change webhook configuration only with:

```bash
ocd deploy --dry-run
ocd deploy
```

Inspect the stored webhook and staging sibling:

```bash
ocd app webhook status my-app
ocd app staging my-app
```

Every app container receives the platform-owned runtime marker
`OCD_DEPLOY_TARGET=production|staging`. Environment and manifest values cannot
override it. Use it for fail-closed guards against production databases,
storage prefixes, payment/email credentials, schedulers, and other side effects.

For stacks, enabling staging on any member also reconciles isolated staging
counterparts for every declared managed service and injects their credentials
into the stack staging environment. Use top-level `staging_env` declarations
and `ocd deploy stack --staging-set=KEY=VALUE` for non-managed dependencies.

## Promotion

Promotion is an explicit operational action:

```bash
ocd promote my-app
```

Inspect staging and production commits before promotion. Promotion does not
change the desired webhook manifest.
