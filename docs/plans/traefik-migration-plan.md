# Implementation Plan: Caddy → Traefik + Private Apps, Auto-Domains, Unified Internal Ingress

Produced 2026-07-12. Scope: replace Caddy with Traefik as the only proxy on every server;
implement features A (private apps first-class), B (real auto-domains), C (one internal
path for HTTP and TCP via per-app `internal_port` 20000–20199, 200 = hard app cap).

## 0. Verified ground truth (key callsite inventory)

**Callers of `syncAppCaddy`** (all must keep working through a renamed `syncAppIngress`):
`src/engine/reconciler.ts:304`, `src/engine/scale/wake.ts:120`, `src/engine/scale/scale-up.ts:178,216`, `src/engine/scale/rolling.ts:54,99`, `src/engine/scale/migrate.ts:131,155,224,371`, `src/engine/scale/scale-down.ts:49,144`, `src/engine/deploy/lifecycle.ts:318,360`, `src/engine/ops/wake.ts:50`, `src/engine/ops/redeploy.ts:263,309`, `src/engine/ops/scale-up.ts:120`, `src/engine/ops/scale-down.ts:67`, `src/engine/ops/migrate.ts:74,83,114,154`, `src/engine/ops/rollback.ts:232-233`, `src/engine/ops/deploy.ts:749`.

**Callers of `removeAppCaddy`**: `src/engine/scale/scale-down.ts:115`, `src/engine/deploy/lifecycle.ts:85`, `src/engine/ops/deploy.ts:758`, `src/engine/ops/destroy-app.ts:104`.

**Callers of `syncServiceCaddy` / `removeServiceCaddy` / `getPanelIngressIpv4`**: `src/engine/ops/deploy-service.ts:133,500,513`, `src/engine/deploy/service-lifecycle.ts:104`.

**Wake-page machinery**: `deployCaddyWakePage`/`removeCaddyWakePage`/`wakePageHtml` in `src/engine/hetzner/containers.ts:446-610`; installed by `src/engine/scale/scale-down.ts:103-136` (sleep path), removed by `syncAppCaddy` (caddy-manager.ts:456-462) and `removeAppCaddy` (513-519). The wake page HTML calls panel endpoints `handleWakeApp`/`handleWakeStatus` (`src/server/routes/scaling.ts:167-206`) — those endpoints are proxy-agnostic and stay.

**Panel bootstrap**: `src/engine/deploy/panel.ts:329-337` calls `deployCaddySite` (containers.ts:339); panel server is created with `userData: ""` (panel.ts:174) so it gets the *default* cloud-init from `src/shared/providers/hetzner.ts:114` → `cloudInitScript()` — one cloud-init template serves the whole fleet.

**What's injected into env vars today**: nothing auto-references `:8080`. Managed-service links inject `_HOST` = service host **private IP** and `_URL` built from it (`src/engine/ops/deploy-service.ts:280-300, 529-549`). Apps get no platform-injected vars at all. The only `:8080` surface is UI copy (`src/web/src/pages/app-detail/overview-tab.tsx:22`) and whatever users hand-pasted into env vars → **keep :8080 as an internal-HTTP compat alias in Traefik**, retire later.

**Rename gap (pre-existing)**: `src/engine/ops/rename-app.ts` never resyncs the proxy; the desired-state renderer below fixes this class of bug structurally (next reconciler tick converges), but add an explicit sync at the end of the rename op.

**No UI path edits `apps.domain`** (`updateAppDomain` at `src/shared/db/apps.ts:312` is unused) — domain is fixed at deploy time. This simplifies A and B considerably.

**Migrations**: last version is **59** (`src/shared/migrations.ts:1256`); `initSchema` (`src/shared/db/connection.ts:35-46`) creates a minimal apps table and migrations add everything else, so new columns go in migrations only.

---

## 1. PR-sized phases (sequencing) — REVISED after live-fleet audit (2026-07-12)

**Fleet audit result** (via ocd CLI + SSH): 2 servers (server-2 + panel), 13 apps, 0 managed
services, **0 password-protected apps** (no `-auth` containers running or stopped anywhere),
nothing listening in 20000–20199 on either server, all replica ports 10001–10014 bound to
private IPs. ~11 public domains, all under cero-ai.com (LE budget fine).

**Consequence: no in-code fleet migration.** The original PR4 (migrate_server_proxy /
migrate_fleet_proxy ops), the `ingress.ts` dual-proxy dispatcher, and the `servers.proxy`
column are all dropped. The cutover is a one-time manual runbook (§5). Code is Traefik-only
from PR3 onward; Caddy code is deleted in PR3 itself, not a later cleanup PR. The auth-proxy
port collision (old risk #1) reduces to changing `AUTH_PROXY_PORT_OFFSET` in PR1 — no live
auth proxies exist to migrate.

| PR | Content | Risk | Ships independently? |
|----|---------|------|---------------------|
| **PR1** | Schema: `internal_port` + allocation + 200-cap; **Feature A** backend (no domain/DNS/public route for private apps, scaling gate fix); service env-injection fix (`svc.ocd.internal`); UI PRIVATE badge (still showing `:8080` URL); `AUTH_PROXY_PORT_OFFSET` 10000→30000 (constant only — no live auth proxies) | Low | Yes — fully proxy-agnostic |
| **PR2** | **Feature B**: auto-domain `<app>.<zone>` when zone configured; `dns_zone_name` setting; nip.io only as fallback | Low | Yes — works under Caddy (LE via Caddy today) |
| **PR3** | Traefik replaces Caddy in code outright: `traefik-config.ts` + `traefik-manager.ts`, all callsites renamed to it directly (no dispatcher), cloud-init switch, panel bootstrap switch, panel-served wake page, **delete** `caddy-manager.ts` + Caddy fns in `containers.ts` | Medium | Deploy panel only together with the manual cutover (§5) |
| **Manual cutover** | Runbook in §5, executed once by the operator (~15 min) | Medium, rollback = restart caddy | — |
| **PR5** | **Feature C** surface: UI/CLI flip to `<app>.ocd.internal:<internal_port>`, `OCD_INTERNAL_*` env injection, `internalAppUrl` update | Low | After cutover |
| **PR6** | Residual cleanup: `apt-get remove caddy` on both servers (manual), docs/README | Low | Last |

---

## 2. PR1 — Schema + Feature A + service env fix

### 2.1 Migration 60 (`src/shared/migrations.ts`)

```ts
{
  version: 60,
  description: "Add apps.internal_port (fleet-unique, 20000-20199) and backfill",
  up: (db) => {
    db.run("ALTER TABLE apps ADD COLUMN internal_port INTEGER NOT NULL DEFAULT 0");
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_internal_port ON apps(internal_port) WHERE internal_port > 0");
    const apps = db.query("SELECT id FROM apps ORDER BY id ASC").all();
    if (apps.length > 200) throw new Error("More than 200 apps — internal port block exhausted");
    apps.forEach((a, i) => db.run("UPDATE apps SET internal_port = ? WHERE id = ?", [20000 + i, a.id]));
  },
},
{
  version: 61,
  description: "Blank domains of private apps (no public ingress)",
  up: (db) => { db.run("UPDATE apps SET domain = '' WHERE public = 0"); },
}
```
(`domain` is `TEXT NOT NULL` — use `''`, not NULL; every `app.domain &&` check in the codebase already treats `''` as absent.)

### 2.2 Allocation (`src/shared/db/apps.ts`)

- Add `internal_port: number` to `AppRow` and to the App interface in `src/engine/scale/types.ts:3-43` and `src/web/src/types.ts` (`AppData`).
- New exports:
  ```ts
  export const INTERNAL_PORT_BASE = 20000;
  export const INTERNAL_PORT_COUNT = 200; // hard fleet app cap
  export function allocateInternalPort(): number   // lowest free in block; throws clear error when exhausted
  export function countApps(): number
  ```
  `allocateInternalPort` reads `SELECT internal_port FROM apps WHERE internal_port > 0`, picks the lowest gap. Call it **inside** the `insertAppWithFirstReplica` transaction (`apps.ts:123-168`) and in `insertApp`; the unique index is the concurrency backstop. Freeing = row deletion (index frees automatically). Ports are never reallocated on redeploy/move/scale because they live on the app row.
- Cap pre-flight: in `pickOrProvisionServer` (`src/engine/ops/deploy.ts:122`) before any provisioning: `if (db.countApps() >= INTERNAL_PORT_COUNT) throw new Error("Fleet limit of 200 apps reached (internal port block 20000-20199 is full). Destroy an app before deploying a new one.")`.

### 2.3 Feature A — deploy op (`src/engine/ops/deploy.ts`)

- New pure helper (put in deploy.ts or `src/shared/validate.ts`):
  ```ts
  function resolveAppDomain(req, settings, ingressIp): { domain: string; managedDns: boolean }
  // public===false           -> { domain: "", managedDns: false }
  // req.domain               -> { domain: req.domain, managedDns: !!settings.dns_zone_id && inZone }
  // (PR2 adds the auto-domain branch here)
  // fallback                 -> { domain: `${app}.${ingressIp}.nip.io`, managedDns: false }
  ```
- `insertAppRow.run` (line 388) and `.probe` (line 352): replace the unconditional nip.io fallback with `resolveAppDomain`. `useInternalTls` becomes `domain.endsWith(".nip.io")`.
- `createDnsRecord.run` (line 204-254): `if (req.public === false) return null;` before the existing `!req.domain || !dnsZoneId` guard.
- `syncCaddyStep.run` (line 726-763): skip the DNS-resolution pre-check when `req.public === false`; log message becomes "internal ingress configured" when domain is empty.
- `enqueueScaleChild` (line 935): change `if (!req.replicas || req.replicas <= 1 || !req.domain)` → allow private apps: `... || (req.public !== false && !req.domain)`.
- `validateDeployRequest` (`src/shared/validate.ts:325-345`): reject `public === false && domain` with "Private apps cannot have a public domain — remove `domain` or set `public: true`".

### 2.4 Feature A — scaling gates

- `src/server/routes/scaling.ts:20` → `if (replicas > 1 && app.public && (!app.domain || app.domain.endsWith(".nip.io")))`.
- `src/server/routes/scaling.ts:91` → same `app.public &&` guard.
- `src/web/src/pages/app-detail/scaling-tab.tsx:77,154,158,194,196`: every `(!app.domain || app.domain.endsWith(".nip.io"))` gate becomes `app.public && (...)`.
- Scale-to-zero for private apps: in `src/engine/scale/scale-down.ts:103-136`, guard the wake-page install with `if (app.domain)` (a private app has no public URL to serve a wake page on; it still sleeps and wakes via dashboard/CLI — `handleScaleApp` already routes scale-up of sleeping apps through the wake op, scaling.ts:31-41). Document in the UI (scaling-tab) that private sleeping apps wake only via dashboard/CLI/API.

### 2.5 Feature A — Caddy manager touch-up (interim, deleted in PR6)

`syncAppCaddy` already gates the public route on `app.public` (caddy-manager.ts:433-448) and deletes stale ones — no change needed; with `domain=''`, `removeCaddyWakePage`/DNS paths are already guarded by `app.domain &&`.

### 2.6 Feature A — UI / CLI

- `src/web/src/pages/dashboard.tsx:186-194`: when `!app.public`, render `` `${app.name}.ocd.internal:${app.internal_port}` `` with a `CopyButton` and a `PRIVATE` badge instead of the `https://` link. (In PR1, show port `8080` until Traefik lands; flip to `internal_port` in PR5.) Add `internal_port`/`public` to the local `AppRow` type at dashboard.tsx:9.
- `src/web/src/pages/app-detail/overview-tab.tsx:22,66-77`: same; add PRIVATE badge next to "Public Access: Disabled".
- CLI: `src/cli/commands/apps.ts`, `status.ts`, `deploy.ts` print `domain` — print `<app>.ocd.internal:<internal_port> (private)` when `public` is false / domain empty. `src/cli/api.ts:45` type gets `public`/`internal_port`.

### 2.7 Managed-service env fix (`src/engine/ops/deploy-service.ts`)

- Line 280-300 (`insertServiceAndInstance`): introduce `const stableHost = \`${req.name}.svc.ocd.internal\`;` and use it for `credentials.host` and in `buildConnectionUrl(catalog, envVars, stableHost, hostPort)` (non-HTTP branch). Keep `bindAddress` for the actual `docker run`/health-check plumbing (lines 415-462, 565-603) — only the *credentials* object changes.
- Lines 529-549 (`injectCredentials`) need no change — they read `credentials.host`/`connection_url`.
- `/etc/hosts` already maps `<svc>.svc.ocd.internal` → service host private IP on every server (`src/engine/scale/network-reconciler.ts:90-97`), so this works fleet-wide today with zero proxy involvement.
- Existing environments keep stale IPs; document that re-linking refreshes them — do **not** rewrite user environments automatically.

### 2.8 Tests (PR1)

- `src/shared/migrations.test.ts`: migration 60 backfills unique sequential ports; migration 61 blanks private domains.
- New `src/shared/db/apps.test.ts` cases: allocate returns lowest gap; exhaustion at 200 throws; port survives replica delete/re-add.
- `src/engine/ops/deploy.test.ts` (mocks already in place at :38-40): private deploy → `domain === ""`, `create_dns_record` output null, no scale-child gate error.

---

## 3. PR2 — Feature B: real auto-domains

### 3.1 Zone name resolution

- New settings key `dns_zone_name` (settings is a KV table — no migration needed).
- `src/server/routes/settings.ts` (`handleSaveSettings`) and `src/server/routes/setup.ts:118`: when `dns_zone_id` is saved non-empty, call `hetznerDns.listZones()` (`src/shared/providers/hetzner.ts:258-261`, backed by `src/engine/hetzner/dns.ts:89-92`), find the zone by id, `db.saveSetting("dns_zone_name", zone.name)`; clear it when zone id is cleared. Lazy fallback: `resolveAppDomain` may fetch+cache if `dns_zone_id` set but name missing.

### 3.2 Deploy changes (`src/engine/ops/deploy.ts`)

- `resolveAppDomain` gains the branch: `public && !req.domain && settings.dns_zone_id && zoneName` → `{ domain: \`${app_name}.${zoneName}\`, managedDns: true }`. nip.io remains only when no zone is configured.
- `createDnsRecord` (line 204): compute the effective domain via the same helper instead of requiring `req.domain`; create the A record for auto-domains too (`name = app_name`, value `server.ingressIp`). The `dns_records` row insert at line 447-456 already persists it, and `destroy-app.ts:110-131` already cleans it up. Compensation (line 240) unchanged.
- `syncCaddyStep` DNS pre-check (line 735): unchanged logic already skips when `dns` output is non-null, which now covers auto-domains. LE issuance may briefly retry until the record propagates (both Caddy and Traefik retry automatically).
- Panel bootstrap (`src/engine/deploy/panel.ts:188-192`) is untouched — nip.io stays the panel fallback.
- Webhook/wake URLs use `panel.domain` only (`deploy.ts:879-883`, `scale-down.ts:110`) — no interaction.

### 3.3 Tests

- Unit-test `resolveAppDomain` (all four branches).
- Integration (`src/integration/engine-ops.test.ts`, `dnsTest` pattern at :45): with `OCD_TEST_DNS_ZONE`, deploy without `domain` → expect `app.domain === \`${name}.${zoneName}\`` and a dns_records row.

---

## 4. PR3 — Traefik infrastructure

### 4.1 New module: `src/engine/scale/traefik-config.ts` (pure, unit-testable)

Constants: `INTERNAL_PORT_BASE=20000`, `INTERNAL_PORT_COUNT=200`, `INTERNAL_HTTP_COMPAT_PORT=8080`, `TRAEFIK_VERSION` (pin a v3.5+ release — TCP health checks require ≥ v3.5, see risks).

**`traefikStaticConfig(): string`** — identical on every server:
```yaml
entryPoints:
  web:       { address: ":80" }
  websecure: { address: ":443" }
  internal-http: { address: ":8080" }   # compat alias
  int20000:  { address: ":20000" }
  # ... generated loop through int20199
providers:
  file: { directory: /etc/traefik/dynamic, watch: true }
certificatesResolvers:
  letsencrypt:
    acme: { storage: /etc/traefik/acme.json, httpChallenge: { entryPoint: web } }
api: { dashboard: false }
```
The ACME resolver is inert on workers (no router references it there). Emit as JSON (`JSON.stringify(obj, null, 2)` into a `.yml` file — JSON is valid YAML), avoiding a YAML serializer dependency. The port block is fixed forever (200 = hard app cap), so **static config never changes after install → no restarts in steady state**.

**`renderDynamicConfig(state: DesiredState, opts: { isPanel: boolean }): string`** — desired-state render of `/etc/traefik/dynamic/ocd.yml` from a `DesiredState` snapshot gathered from the DB (`collectDesiredState()` reads apps, replicas, servers, services, panel row). Per app with servable replicas (`running`|`unhealthy`, same filter as `buildUpstreams`, caddy-manager.ts:181-203, including the `authProxyPort(host_port)` indirection when `auth_password` set):

- HTTP app (`health_check == 1`):
  - `http.services.app-<name>: loadBalancer: servers: [{url: "http://<priv-ip>:<port>"}...]`. Traefik has no passive health checks and apps don't guarantee a health path — attach a `retry` middleware (`attempts: 3`) to approximate Caddy's `try_duration` failover; document the behavioral difference.
  - Internal router on every server: `http.routers.int-<name>: { entryPoints: [int<port>], rule: "PathPrefix(\`/\`)", service: app-<name> }`.
  - Compat router: `{ entryPoints: [internal-http], rule: "Host(\`<name>.ocd.internal\`)", service: app-<name> }`.
- TCP app (`health_check == 0`):
  - `tcp.services.app-<name>: loadBalancer: servers: [{address: "<priv-ip>:<port>"}...]` **with TCP `healthCheck` (interval/timeout)** — the direct replacement for Caddy's passive checks in TCP mode.
  - `tcp.routers.int-<name>: { entryPoints: [int<port>], rule: "HostSNI(\`*\`)", service: app-<name> }`.
- Panel only (`opts.isPanel`), public apps with domain and **not sleeping**:
  - `http.routers.pub-<name>: { entryPoints: [websecure], rule: "Host(\`<domain>\`)", service: app-<name>, middlewares: [sec-headers], tls: { certResolver: letsencrypt } }` — for `.nip.io` domains use `tls: {}` (Traefik's built-in default self-signed certificate; **this replaces `ensureNipIoTlsPolicy`**, caddy-manager.ts:371-402).
  - One global `web`→`websecure` redirect router + `redirectScheme` middleware (ACME HTTP-01 bypasses it automatically).
  - `sec-headers` middleware reproducing the header set from `buildPublicRoute` (caddy-manager.ts:250-258).
- Panel only, **sleeping** public apps (wake page): router `Host(<domain>)` → `http.services.ocd-panel: loadBalancer: servers: [{url: "http://127.0.0.1:<panel.host_port>"}]`. Same for services routes: `http.routers.svc-<name>` → single-upstream service (replaces `syncServiceCaddy`, caddy-manager.ts:565-606).
- Apps with zero servable upstreams simply render no routers (replaces the `removeAppCaddy` call inside `syncAppCaddy`, line 420-424).

### 4.2 Wake page moves into the panel server (replaces `deployCaddyWakePage`)

Traefik has no `static_response` handler, so the wake page becomes a panel HTTP responder:
- New `src/server/lib/wake-page.ts`: move `wakePageHtml` from `containers.ts:446-499` (panelOrigin/appId/wakeToken params unchanged).
- In `src/server/index.ts` request routing, before 404/SPA handling: if the request's `Host` header ≠ panel domain, look up `db.getAppByDomain(host)` (`src/shared/db/apps.ts:78-82`); if found and `status ∈ {sleeping, waking}` and `wake_token` set → respond `503` with `wakePageHtml(...)`. Existing wake/wake-status endpoints (`scaling.ts:167-206`) are reused as-is.
- `scale-down.ts:103-136` no longer calls `deployCaddyWakePage`/`removeAppCaddy` on Traefik servers — it just updates DB state and calls the ingress sync (the renderer routes sleeping domains to the panel automatically). Same for wake (`scale/wake.ts:119-123`) — the post-wake `syncAppIngress` re-renders the pool router.

### 4.3 New module: `src/engine/scale/traefik-manager.ts`

- `syncServerTraefik(server: ServerAccess): Promise<void>` — render `ocd.yml` for that server (isPanel = server hosts panel), compare against an in-memory content-hash cache keyed by `server.ipv4` (replaces `lastUpstreamsByApp`; since the panel router lives in a *separate* never-touched `panel.yml`, the Caddy WebSocket-drop hazard the cache existed for is gone — the cache is now just an SSH-traffic optimization), and if changed write atomically over SSH: `cat > /etc/traefik/dynamic/.ocd.yml.tmp && mv -f .ocd.yml.tmp ocd.yml` (extend/parallel `deployConfigFile`, `containers.ts:1470-1480`, with a tmp+mv variant — `watch: true` picks it up with zero restart).
- `syncAllTraefik()`, and the public API mirroring today's shapes so callsites are a mechanical rename:
  - `syncAppIngress(appId, force?)` → `syncAllTraefik()` (desired-state render makes the appId argument advisory)
  - `removeAppIngress(appName, domain, appId?)` → also `syncAllTraefik()` (rows already deleted ⇒ routers disappear)
  - `syncServiceIngress(opts)` / `removeServiceIngress(name)`
  - `getPanelIngressIpv4()`, `internalAppUrl(appName, internalPort)` = `` `http://${appName}.ocd.internal:${internalPort}` ``
- `ensureTraefikInstalled(server)` — idempotent over SSH: check `/usr/local/bin/traefik version`, else download pinned static binary from GitHub releases (`traefik_v${V}_linux_amd64.tar.gz`), write static config + systemd unit `ocd-traefik.service` (root, `Restart=always`), `touch /etc/traefik/acme.json && chmod 600`.

### 4.4 Callsite rename (no dispatcher — clean cut)

- ~~Dual-proxy dispatcher + `servers.proxy` column~~ **dropped** after the fleet audit; the cutover is manual (§5), so the code only ever knows Traefik.
- All ~25 callsites listed in §0 switch from `caddy-manager.ts` imports to `traefik-manager.ts` (`syncAppIngress`/`removeAppIngress`/`syncServiceIngress`/`getPanelIngressIpv4` names) — a mechanical, single-PR rename. Test mocks (`deploy.test.ts:38`, `reconciler.test.ts:30`, `recovery.integration.test.ts:74`, `destroy-app.test.ts:38`) re-point accordingly.
- `caddy-manager.ts`, `deployCaddySite`/`deployCaddyWakePage`/`removeCaddyWakePage`/`persistCaddyConfig` in `containers.ts` (+ exports in `src/engine/hetzner/index.ts:23`, `src/shared/remote/index.ts:19-21`) are **deleted in this same PR**.
- Reconciler: `src/engine/reconciler.ts` tick (around :588, next to `reconcileNetwork()`) adds a periodic `syncAllTraefik()` drift-repair + `ensureTraefikInstalled` for any ready server missing the binary (mirrors `ensureInternalServer` semantics). This is also what populates dynamic configs right after the manual cutover.

### 4.5 Provisioning: `src/shared/providers/cloud-init.ts`

Replace the Caddy block (lines 75-112) with: Traefik binary download (pinned version, arch-detected via `uname -m`), `/etc/traefik/traefik.yml` heredoc (embed `traefikStaticConfig()` output directly in the template), empty `/etc/traefik/dynamic/`, `acme.json` perms, systemd unit, `systemctl enable --now ocd-traefik`. Keep the `/root/.provisioned` sentinel.

### 4.6 Panel bootstrap: `src/engine/deploy/panel.ts`

- Replace `deployCaddySite` call (lines 329-337) with a new `deployTraefikPanelSite(serverIp, domain, hostPort, internalTls, hostKey)` (new file `src/engine/hetzner/traefik.ts` or inside traefik-manager): writes `/etc/traefik/dynamic/panel.yml` containing router `panel` (`Host(domain)`, entryPoints websecure + web-redirect) → service `ocd-panel` (`http://127.0.0.1:${hostPort}`), with `tls: { certResolver: letsencrypt }` or `tls: {}` for the nip.io case (self-signed default cert, replacing the internal-issuer policy at panel.ts:330,360). `panel.yml` is owned by bootstrap/redeploy and never rewritten by the engine's `ocd.yml` render — panel WebSocket/terminal sessions are never disturbed by app syncs.
- `redeployPanel` (panel.ts:450+) needs no proxy work (host-level Traefik and its config survive the container rebuild; `acme.json` lives on the host).

### 4.7 Tests

- New `src/engine/scale/traefik-config.test.ts` (pure): given fixture apps/replicas/servers rows (via `useTempDataDir` + db inserts, same pattern as existing engine tests), assert: HTTP router shape, TCP router for `health_check=0`, auth-proxy port substitution, public router only on panel + only for public non-sleeping apps, nip.io → `tls:{}`, sleeping app → panel service target, empty-upstream app renders nothing, compat :8080 router, deterministic output (stable key order for the content-hash cache).

---

## 5. Manual cutover runbook (replaces the PR4 migration op)

One-time, operator-executed, ~15 minutes. Pre-conditions: PR1–PR3 merged; new panel image
built but **not yet deployed**; both servers ready; no deploys in flight.

Per server, **server-2 first, panel last** (server-2 only risks internal traffic; the panel
carries public traffic + ACME):

1. **Install Traefik alongside Caddy** (no port conflict yet — Traefik not started):
   download the pinned binary, write `/etc/traefik/traefik.yml` (full static config from
   `traefik-config.ts` — copy from a local `bun` eval), empty `/etc/traefik/dynamic/`,
   `touch /etc/traefik/acme.json && chmod 600`, install the `ocd-traefik.service` unit
   (disabled). Optionally pre-render `/etc/traefik/dynamic/ocd.yml` with the new renderer
   against a copy of the panel DB to shrink the routing gap to ~zero; otherwise the
   reconciler fills it within one tick (~30 s) after step 4.
2. **Cutover**: `systemctl stop caddy && systemctl disable caddy && systemctl enable --now ocd-traefik`.
3. **Verify**: on server-2 — `curl -sf http://<private-ip>:8080` compat route once dynamic
   config exists; TCP connect to bc-postgres' internal port. On the panel —
   `https://<panel-domain>` and one public app answer with fresh LE certs (Caddy's cert
   store isn't portable; ~11 reissues, well under the 50/week LE limit; allow a retry
   window for issuance).
4. **Deploy the new panel version** immediately after the panel cutover — its reconciler's
   `syncAllTraefik()` + `ensureTraefikInstalled` take over config management from then on.

**Rollback** (per server, any time before Caddy is uninstalled):
`systemctl stop ocd-traefik && systemctl start caddy` — Caddy's persisted
`/etc/caddy/caddy.json` is untouched by any of this. If the new panel code was already
deployed, roll the panel container back too (`ocd rollback` / previous image), since the
new engine only speaks Traefik.

Sleeping apps (3) need no special handling: their wake routes render from DB state on the
new panel; they were serving Caddy wake pages which simply disappear with Caddy.

### 5.3 :8080 compat decision

Keep the `internal-http` entrypoint + `Host(<app>.ocd.internal)` routers indefinitely (cost ≈ zero); UI stops advertising it in PR5. Nothing platform-injected references it (verified §0).

---

## 6. PR5 — Feature C surface

- `src/web/src/pages/app-detail/overview-tab.tsx:22`: `internalUrl = \`${app.health_check ? "http" : "tcp"}://${app.name}.ocd.internal:${app.internal_port}\``; dashboard.tsx private-app row same.
- `internalAppUrl` (now in traefik-manager) — port param from app row; delete the `INTERNAL_PORT` constant export.
- **Platform env injection**: new `platformEnvVars(app)` in `src/shared/env-crypto.ts` returning `OCD_INTERNAL_URL`, `OCD_INTERNAL_HOST` (`<name>.ocd.internal`), `OCD_INTERNAL_PORT`. Merge inside `resolveAppEnvVars` (`env-crypto.ts:178`) — single choke point covering redeploy (`ops/redeploy.ts:132`), wake (`scale/wake.ts:55`), rolling (`scale/rolling.ts:73`), scale-up (`scale/scale-up.ts:88,121`), lifecycle (`deploy/lifecycle.ts:261`), rollback (`ops/rollback.ts:85`), reconciler (`reconciler.ts:141`) — plus a manual merge in first-deploy `insertAppRow`/`buildAndRunContainer` flatEnvVars (`ops/deploy.ts:394-420,638`) since that path uses `resolveEnvVarsForDeploy` (env id must exist → inject after app row insert, i.e. in `buildAndRunContainer`).
- CLI/status output prints the internal URL for every app.
- Integration test additions (`src/integration/engine-ops.test.ts`): after deploy, `sshExec(serverIp, "curl -sf http://127.0.0.1:<internal_port>/")`; a `health_check:false` fixture app reachable via TCP on its internal port; private app: `domain===''`, no public router in `/etc/traefik/dynamic/ocd.yml` on panel.

## 7. PR6 — Residual cleanup

Caddy *code* is already gone (deleted in PR3). Remaining: `apt-get remove caddy` on both
servers manually once the rollback window closes, README/docs updates, remove this plan's
interim notes.

**Legacy auth-proxy sweep (one-time, per server).** The reconciler's automatic
`cleanupLegacyAuthProxies` sweep has been removed, so any leftover pre-basicAuth auth-proxy
sidecars from the old password gate must be cleared by hand once, as root, on each server:

```sh
for u in $(systemctl list-units --all --plain --no-legend 'ocd-auth-*' | awk '{print $1}'); do
  systemctl stop "$u"; systemctl reset-failed "$u";
done
rm -f /home/deploy/apps/*/.auth-proxy.ts
```

(Password protection is now a Traefik `basicAuth` middleware; the old `ocd-auth-<container>`
units and `.auth-proxy.ts` files are dead weight and hold a stale listener in the +30000 port
range.)

---

## 8. Open questions / risks

1. **Auth-proxy port collision — RESOLVED by fleet audit**: `authProxyPort = host_port + 10000` would collide with the internal block, but zero password-protected apps exist (no `-auth` containers on either server, nothing listens in 20000–20199). Change `AUTH_PROXY_PORT_OFFSET` to +30000 in PR1 as a constant-only change; no fleet pass needed.
2. **Traefik TCP health checks require v3.5+** — verify against the pinned release notes at implementation time; if unavailable in the pinned build, TCP pools fall back to no health checking (flag in code comment).
3. **No passive health checks in Traefik HTTP** (Caddy's `fail_duration` model): mitigated by `retry` middleware + the existing reconciler auto-restart of unhealthy replicas (reconciler.ts:196-215). Behavioral difference worth a docs note.
4. **acme.json / LE**: survives panel redeploys (host file), lost on panel server destruction → reissue. Auto-domains mean 1 cert/app: LE limit 50 new certs per registered domain per week — fine below ~50 app-creates/week on one zone; wildcard via DNS-01 is the future escape hatch. Cutover reissues the panel + all app certs once (rate-limit budget: count public apps before migrating).
5. **TCP source IP**: upstream sees the proxy server's private IP (same as today's HTTP path); PROXY protocol deliberately not enabled (apps would need to opt in). Document.
6. **Traefik binds `:20000-20199` on all interfaces**; public exposure is prevented only by the Hetzner firewall (identical to today's `:8080` stance, caddy-manager.ts:16-20). Consider a follow-up to bind entrypoints to the private IP (needs per-server static config — deliberately rejected for now to keep static config fleet-identical).
7. **Dynamic-config reload semantics**: full-file rewrite on any replica change; Traefik hot-reloads without dropping established connections on unchanged routers, but verify WebSocket behavior on *changed* routers during rolling deploys (same exposure Caddy had; the panel is insulated via `panel.yml`).
8. **Private apps + scale-to-zero**: no public wake page ⇒ internal callers hitting a sleeping private app get connection refused until a dashboard/CLI wake. Consider defaulting `scale_to_zero_after=0` for private apps or an internal wake-on-connect in a future iteration.
9. **Migration 60 assumes ≤200 existing apps** — safe (fleet is small), but the migration throws loudly rather than corrupting.
> Historical design record — superseded. OCD now uses provider-neutral manual
> DNS instructions and Let's Encrypt HTTP-01 only. Do not use the DNS-provider
> or wildcard-certificate proposals below as current operational guidance; see
> `src/cli/skill/assets/docs/networking-and-ingress.md`.
