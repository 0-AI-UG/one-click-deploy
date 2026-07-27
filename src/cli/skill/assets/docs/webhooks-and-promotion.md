# GitHub webhooks, staging, and promotion

## Contents

- [Prerequisites](#prerequisites)
- [Production webhook flow](#production-webhook-flow)
- [Branch, path, and CI filtering](#branch-path-and-ci-filtering)
- [Standalone staging](#standalone-staging)
- [Stack staging](#stack-staging)
- [Promotion](#promotion)
- [Disabling and cleanup](#disabling-and-cleanup)
- [Isolation checklist](#isolation-checklist)

## Prerequisites

Enabling a GitHub webhook requires:

- an app with a GitHub repository;
- a linked GitHub account/token for the acting user;
- a public panel domain;
- permission to manage the app's webhooks.

OCD registers a GitHub webhook URL containing the app ID and stores a random
secret. Incoming payloads are verified with HMAC-SHA256 using constant-time
comparison.

## Production webhook flow

With webhook enabled and no staging environment:

1. GitHub sends a push.
2. OCD verifies signature, repository/app, and configured branch.
3. OCD applies the optional path filter.
4. OCD optionally waits for CI.
5. OCD enqueues a redeploy pinned to the pushed commit.
6. The rollout uses stored OCD configuration; it does not reread the manifest.

Webhook settings can themselves be applied from a manifest, but future pushes
use the stored settings.

## Branch, path, and CI filtering

- Branch defaults to `main`.
- Path filters have surrounding whitespace and leading/trailing slashes
  removed.
- An empty path matches every push.
- A non-empty path matches an exact changed path or descendants across added,
  modified, and removed files.

When `wait_for_ci` is enabled, OCD polls GitHub every 15 seconds for up to 30
minutes:

- success proceeds;
- failure records a failed webhook deployment and skips rollout;
- timeout records failure and skips rollout;
- if no GitHub token is available for checking, OCD proceeds rather than
  blocking indefinitely.

## Standalone staging

Manifest:

```json
{
  "webhook": {
    "enabled": true,
    "branch": "main",
    "staging": true
  }
}
```

Staging is represented by an explicit environment selected on the production
app and a hidden `<name>-staging` sibling app.

- With no selected staging environment, manifest deployment creates
  `<app>-staging-env` as a copy of production, or an empty environment when
  production has none.
- Override with `ocd deploy --staging-env=<name|id>`.
- Pushes deploy the exact commit to the sibling and hold production.
- The sibling has its own containers/status/domain and uses the selected
  staging environment.

## Stack staging

Each participating child app opts in through its own webhook manifest settings.
The stack has exactly one shared staging environment:

- default name `<stack>-stack-staging-env`;
- auto-copied from the production stack environment when first needed;
- selected with `ocd deploy stack --staging-env=<name|id>`;
- remembered across re-ups;
- cleared with `--staging-env=`.

Every opted-in member's hidden staging sibling uses that one environment.
Promotion follows persisted stack dependency levels.

## Promotion

```bash
ocd promote
ocd promote --from=<source> --to=<destination>
ocd promote stack <name>
```

Promotion does not merge runtime state. It:

1. finds the source's latest successful deployed commit;
2. verifies source and destination differ;
3. warns when repositories differ;
4. rebuilds the destination pinned to that exact commit;
5. uses the destination's stored desired configuration.

No-argument promotion derives source/destination from the current repo
manifest. Stack promotion skips members without a ready/deployed staging
sibling and promotes dependency levels in order.

The UI enables promotion only when staging has a commit different from
production.

## Disabling and cleanup

Disabling a webhook tries to delete the GitHub registration, then clears stored
enablement/secret/ID. A GitHub API cleanup failure is logged and does not keep
the app internally enabled.

Destroying a production app also destroys its hidden staging sibling and tries
to remove webhook registration. Both production and staging environments are
retained.

## Isolation checklist

Copying production to staging includes credentials and live service URLs.
Before the first staging push:

1. create/copy a staging environment;
2. deploy staging databases, queues, and other stateful dependencies;
3. replace copied production URLs and credentials;
4. verify external API keys, email/SMS delivery, payment modes, and object
   storage are safe;
5. select that environment with `--staging-env`;
6. push and inspect the staging sibling;
7. promote only after validating the exact displayed commit.
