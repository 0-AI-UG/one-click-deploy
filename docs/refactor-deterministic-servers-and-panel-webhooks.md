# Refactor: deterministic server lifecycle + panel-driven webhooks

## Goals

1. Remove the "primary server" concept. Servers are pure capacity. A server is destroyed iff it has zero replicas, zero apps, and is not the panel's host.
2. Webhooks live on the panel, not on tenant servers. The panel receives GitHub deliveries and orchestrates rolling redeploys across all replicas.
3. Panel self-redeploy uses the same webhook path as tenant apps — one mechanism, not two.
4. Deployment history is written directly to the DB by the webhook handler. Drop the on-server log fallback entirely.

## Non-goals

- No production data migration (no live users yet — breaking schema is fine).
- No registry / image-shipping. Each replica still builds from git on its own server.
- No multi-region or cross-cloud changes.

---

# Phase 1 — Drop the primary server

Make the replica table the single source of truth for "where does an app run." Delete the special-case logic that protects `apps.server_id` from cleanup.

## 1.1 Schema (migration 14)

- `ALTER TABLE apps DROP COLUMN server_id`
- `ALTER TABLE apps DROP COLUMN host_port`
- The single source of truth for "where does app X run, on what port" becomes the `replicas` table. An app with no replicas is in an invalid intermediate state (only briefly, during deploy or destroy).
- `dns_records.app_id`, `volumes`, `auth_password` etc. remain on `apps` — they're app-level, not replica-level.

## 1.2 `db.ts`

- `insertApp` no longer takes `server_id` or computes `host_port`. It only inserts app metadata.
- New `insertAppWithFirstReplica(appFields, serverId)` helper that inserts the app row and the first replica row in one transaction, returning both. Used by `deploy.ts` to keep the invariant "an app always has ≥1 replica after deploy succeeds."
- `getApps(serverId?)` — when `serverId` is passed, derive via `JOIN replicas`. Returns distinct apps that have at least one replica on that server.
- Delete `nextHostPort` (apps-table version). Keep `nextReplicaHostPort` as the only port allocator; simplify it to query only `replicas`.
- New `getServersForApp(appId): server[]` — distinct servers across an app's replicas. Used wherever code today reaches for `app.server_id`.
- New `gcServerIfEmpty(serverId)` helper, single source of truth for the deletion rule:
  ```
  if getReplicasByServer(serverId).length === 0
     && getApps(serverId).length === 0
     && getPanel()?.server_id !== serverId:
       deleteHetznerServer(...) + deleteServer(serverId)
  ```
  Called from `scaleDown`, `destroyApp`, and `deploy.ts` rollback. No more bespoke "is this primary?" checks anywhere.

## 1.3 `scale.ts`

- Delete every reference to `primaryServer` and the "primary server is exempt" branch.
- `scaleUp` / `scaleDown` / `rollbackScaleUp` operate uniformly on the replica set.
- Single-replica Caddy fast path: when `replicas.length === 1`, the lone replica binds to `127.0.0.1:{host_port}` on its server and Caddy proxies to it locally. When scaling 1→2, the existing replica's container is recreated to bind `0.0.0.0` and the LB is provisioned. When scaling 2→1, the surviving replica is recreated back to `127.0.0.1` and the LB is torn down. (This is what scale.ts already does today; the only change is that "the lone replica's server" is computed from `replicas[0].server_id`, not `app.server_id`.)
- Server cleanup post-scale-down uses `gcServerIfEmpty` for *every* affected server, with no primary exemption.

## 1.4 `lifecycle.ts`

- `destroyApp`: iterate replicas, destroy each, then for each affected server call `gcServerIfEmpty`. Drop the entire "if replicas.length === 0, also remove primary container" legacy branch — it can't trigger anymore since deploy always creates a replica row.
- `restartApp`, `pauseApp`, `unpauseApp`, `recreateAppContainer`: drop the legacy `app.server_id` / `app.host_port` fallback paths. Replicas are the only iteration target. For app-level status, derive from the aggregate replica health.
- `destroyServer`: add an explicit guard at the top — if `serverId === getPanel()?.server_id`, refuse with a clear error. Don't rely on the caller.

## 1.5 `deploy.ts`

- The "create app row → build → create replica row at the end" sequence becomes "create app row + first replica row together (status=deploying) → build → update replica status." This way the GC invariant holds throughout.
- `rollback` uses `gcServerIfEmpty(state.dbServerId)` instead of the bespoke `state.serverIsNew && remainingApps.length === 0` check. Drop `state.serverIsNew` entirely.
- The webhook setup block at lines 517-548 is deleted in Phase 2 — Phase 1 leaves it temporarily (we just stop passing `app.host_port` and use the replica's port).

## 1.6 Callsite sweep

Files that read `app.server_id` or `app.host_port` and need updating:

- `src/server/routes/webhooks.ts` — gets fully rewritten in Phase 2; in Phase 1, just make it derive server from `replicas[0]` so it still compiles.
- `src/server/routes/apps.ts` — likely uses `app.server_id` for logs/exec. Switch to "pick any replica's server" or "first replica's server."
- `src/server/routes/volumes.ts` — same.
- `src/server/routes/scaling.ts` — same.
- `src/bun/deploy/redeploy.ts` — same (also rewritten in Phase 2 but needs to compile in Phase 1).
- `src/web/src/pages/app-detail.tsx` — frontend display only. Either drop the "server" column from the app payload or have the API populate it from `replicas[0].server_id`. Add `servers: number[]` to the API response so the UI can show all servers an app spans.

## 1.7 Tests

- `migrations.test.ts`: verify migration 14 runs cleanly against a DB that has data from migration 8 (apps with `server_id` and a corresponding replica row).
- New `lifecycle.test.ts` or `scale.test.ts` integration-style test (mocked Hetzner) covering: destroying the last replica on a non-panel server triggers server deletion; destroying the last replica on the panel's server does NOT.

## 1.8 Manual smoke test

- Deploy a fresh app → confirm one replica row, no `app.server_id` reference anywhere.
- Scale up to 3 → LB created, second/third servers provisioned.
- Scale down to 1 → secondary servers destroyed automatically; primary server (the one with the surviving replica) untouched.
- Destroy app → server is destroyed (assuming no other apps), unless it's the panel's server.

---

# Phase 2 — Panel-hosted webhooks for tenant apps

Move webhook receiving from per-app on-server scripts to a single panel HTTP endpoint that orchestrates rolling redeploys across replicas.

## 2.1 New panel route

- `POST /webhooks/github/:appId`
- Verifies `X-Hub-Signature-256` against the app's stored `webhook_secret` using HMAC-SHA256, constant-time compare. Reject with 401 on mismatch.
- Parses the GitHub `push` payload, checks `ref === refs/heads/{app.webhook_branch}`. Ignore other refs with 204.
- Enqueues a redeploy job for the app. Returns 202 immediately so GitHub doesn't time out.
- All redeploy jobs run through a single in-process queue keyed by `app_id` so two pushes for the same app can't race; pushes for different apps run in parallel.

## 2.2 Rolling redeploy orchestration

For a non-panel app:

1. Insert a `deployment_history` row up front with `status='in_progress'`, `source='webhook'`, the incoming git SHA, an empty `deploy_log`. Use its id to append progress.
2. Fetch `replicas = getReplicas(appId)`.
3. For each replica, sequentially:
   - If multi-replica: drain from LB (remove target, wait ~10s for in-flight requests).
   - SSH to the replica's server. `git pull` + rebuild image + `docker rm -f` + `docker run` the new container. (Reuses the existing build helpers in `hetzner/`.)
   - Health check the new container on its `host_port`. If unhealthy: mark deployment row `status='failed'`, abort the rollout, leave already-updated replicas at the new version, log clearly.
   - If multi-replica: re-add to LB, wait for LB health.
4. On success: mark deployment row `status='deployed'`, append final log line.
5. Single-replica path skips all LB steps — just rebuild in place behind Caddy.

**Failure semantics:** stop the rollout on first replica failure, don't roll back already-updated replicas (matches kubectl `RollingUpdate` default).

## 2.3 Webhook enable/disable rewrite

`handleEnableWebhook` becomes:

- Generate `secret = randomUUID()`
- Save to apps row: `webhook_enabled=1`, `webhook_secret`, `webhook_branch`
- `github.createWebhook({ url: 'https://{panel.domain}/webhooks/github/{appId}', secret })`
- Save the resulting GitHub webhook ID to the app row

No SSH. No `deployWebhookReceiver`. No `setupAppWebhook`. No Caddy route on the tenant server.

`handleDisableWebhook` becomes:

- `github.deleteWebhook(...)`
- Clear webhook fields on the app row

No SSH cleanup either.

## 2.4 Dead code to delete

- `setupAppWebhook`, `removeAppWebhook`, `deployWebhookReceiver`, `ensureWebhookCaddyRoute` in `src/bun/hetzner/webhooks.ts`.
- The shell scripts they install on tenant servers.
- Any `/opt/ocd/webhooks` references.
- The `removeAppWebhook` call in `lifecycle.ts:destroyApp` (no longer needed — webhook only exists in DB + GitHub).
- The webhook setup block in `deploy.ts` lines 517-548 (replaced by the new flow which only touches the DB and GitHub API).

## 2.5 Preconditions

- Panel must have a public HTTPS URL GitHub can hit. `panel.domain` must be set; enabling a webhook without a public panel domain returns a hard error.

---

# Phase 3 — Panel self-redeploy via the same webhook path

Unify panel auto-update with the tenant webhook mechanism so there's exactly one redeploy entry point.

## 3.1 Schema (migration 15)

- `ALTER TABLE panel ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''`
- `ALTER TABLE panel ADD COLUMN webhook_enabled INTEGER NOT NULL DEFAULT 0`
- `ALTER TABLE panel ADD COLUMN github_webhook_id TEXT NOT NULL DEFAULT ''`

## 3.2 New panel route

- `POST /webhooks/github/panel`
- Same HMAC verify against `panel.webhook_secret`. Same branch check against `panel.git_branch`.
- On valid push: enqueue a panel redeploy. The handler reuses the existing `deploy/panel.ts` redeploy logic (build new image, `docker rm -f` + `docker run` on the panel's own server, health check).
- Since the panel kills its own container mid-request, the redeploy is dispatched as a detached background task before the HTTP response returns — same trick as today.
- Panel redeploys append to `panel_deployments` (the existing table). `source='webhook'`.

## 3.3 Enable/disable UI

- Add a toggle in the panel settings page: "Auto-update from main branch."
- Enabling: generate secret, register a GitHub webhook on the one-click-deploy repo pointing at `https://{panel.domain}/webhooks/github/panel`, store the webhook id and secret on the `panel` row.
- Disabling: delete the GitHub webhook, clear the fields.

## 3.4 Drop the old self-redeploy path

- Remove `source='self-redeploy'` distinction in `panel_deployments` (or migrate existing rows to `source='webhook'`).
- Remove the `docker inspect` HOSTNAME detection logic.
- The webhook is now the only entry point for panel auto-update.

---

# Phase 4 — Deployment history simplification

Consolidate deployment history into the DB, delete the on-server log fallback that no longer has a writer.

## 4.1 Cleanup

- All deployment history writes happen in the panel: the webhook handler inserts the row, updates `status` + `deploy_log` as the rolling redeploy progresses.
- Delete the JSONL parser, the `getLatestWebhookDeploymentTs` reconciliation logic if it becomes unused, the on-server `webhooks/{app}.history.jsonl` files, and any code that reads them.
- `getDeployments(appId)` becomes a straight DB query with no merging — what's already there.

## 4.2 Verify

- Dashboard deployment history still renders for both tenant apps and the panel.
- Webhook-triggered redeploys show up in history with correct status transitions: `in_progress` → `deployed` / `failed`.

---

# Execution order

1. **Phase 1** in a worktree, single commit (or 2: migration+db, then everything else). Verify it compiles, tests pass, run the manual smoke test in 1.8.
2. Merge Phase 1.
3. **Phase 2** in a fresh worktree off the new main. One commit: panel webhook route + rolling redeploy for tenant apps + delete dead receiver code.
4. Merge Phase 2.
5. **Phase 3** in a fresh worktree. One commit: panel self-redeploy via webhook + delete old self-redeploy path.
6. Merge Phase 3.
7. **Phase 4** in a fresh worktree. One commit: history cleanup.
8. Merge Phase 4.

Each phase leaves the tree compiling and the app functional. Phases 2-4 can in principle be combined, but keeping them separate makes review tractable.

---

# Open questions

1. **Concurrent deploy lock granularity** — in-process queue keyed by `app_id` is enough as long as only the panel container handles webhooks. If the panel ever runs >1 replica of itself, we'd need a DB-backed lock. Assuming single-instance panel for now.
2. **Panel webhook UI placement** — confirm the auto-update toggle goes on the existing panel settings page, not somewhere new.
3. **Failure rollback policy** — confirmed default: stop on first failure, don't roll back updated replicas. Worth revisiting if it bites in practice.
