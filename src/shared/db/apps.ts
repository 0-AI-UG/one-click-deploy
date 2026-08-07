import db from "./connection.ts";
import type { ServerRow } from "./servers.ts";
import type { ReplicaRow } from "./replicas.ts";
import { validatePublicPort } from "../validate.ts";

export type AppRow = {
  id: number;
  name: string;
  domain: string;
  git_repo: string;
  git_branch: string;
  dockerfile_path: string;
  docker_context: string;
  source_mode: string;
  image_ref: string;
  build_cache_ref: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
  volume_id: string;
  volume_mount: string;
  /** 0 = volume was CREATED by us (deleted on destroy); 1 = an EXISTING volume
   *  ATTACHED via attach_existing_volume (detached-not-deleted on destroy). */
  volume_attached: number;
  webhook_enabled: number;
  webhook_secret: string;
  webhook_branch: string;
  webhook_path: string;
  github_webhook_id: string;
  /** htpasswd bcrypt hash of the app password for Traefik's basicAuth
   *  middleware. This hash is the sole source of truth for "auth on" — non-empty
   *  ⇔ basic auth enabled. The plaintext is never stored (write-only at the API).
   *  Persisted at set-time (bcrypt salts differ per hash, so hashing at render
   *  time would make every rendered ingress config unique and defeat the
   *  content-hash sync cache). "" = auth disabled. */
  auth_password_hash: string;
  desired_replicas: number;
  min_replicas: number;
  max_replicas: number;
  autoscale_enabled: number;
  autoscale_cpu_threshold: number;
  autoscale_mem_threshold: number;
  autoscale_cooldown: number;
  autoscale_req_threshold: number; // target req/min per replica for HTTP request-based scaling; 0 = off
  last_scale_at: string | null;
  deployed_by: string;
  sleeping_server_id: number | null;
  sleeping_host_port: number | null;
  scale_to_zero_after: number;
  webhook_wait_for_ci: number;
  /** When set, a webhook push deploys to this app's <name>-staging sibling and
   *  holds; production is swapped only on manual Promote. 0 = deploy prod.
   *  Mirror of webhook_staging_environment_id != null. */
  webhook_staging: number;
  /** The environment the webhook staging sibling deploys with. NULL = staging
   *  off. The user selects this explicitly (often a copy of production's env);
   *  the sibling links to exactly this environment — no live inheritance. */
  webhook_staging_environment_id: number | null;
  environment_id: number | null;
  /** NULL = inherit every linked-environment key (legacy). JSON array = only
   *  those keys; [] = platform-injected OCD_INTERNAL_* variables only. */
  env_projection: string | null;
  /** 1 when the linked environment changed since the running containers were
   * created. A plain pause/unpause does not clear it; deploy/redeploy/reload do. */
  environment_stale: number;
  stack_id: number | null;
  /** JSON array of the member keys this stack member depends on, as declared by
   *  `needs` in the stack manifest. NULL for non-members and for members
   *  deployed before migration 84 — treat NULL as "no known edges". */
  stack_needs: string | null;
  public: number;
  public_endpoint_status: string;
  public_endpoint_error: string;
  public_endpoint_checked_at: string | null;
  extra_volumes: string; // JSON array of "host:container" strings
  memory_mb: number; // per-container memory ceiling in MB; 0 = platform default
  cpu_limit: number; // per-container CPU ceiling in cores (fractional allowed); 0 = platform default
  health_check: number; // 1 = HTTP probe (default); 0 = only verify the container is running
  health_check_mode: string;
  health_check_command: string;
  health_check_file: string;
  health_check_max_age_seconds: number;
  /** Internal routing protocol on the app's internal entrypoint: 'http' =
   *  Traefik HTTP router (L7), 'tcp' = raw TCP pass-through. Decoupled from
   *  health_check (which only controls the container probe) — see migration 67.
   *  Auth-protected apps are always effectively HTTP-routed regardless. */
  internal_protocol: string; // 'http' | 'tcp'
  internal_port: number; // fleet-unique internal ingress port (20000-20199), owned for the app's lifetime
  virtual_ip: string; // fleet-unique per-app VIP in 10.96.0.0/16, owned for the app's lifetime
  /** ISO timestamp of the last request observed in Traefik's per-service
   *  counters (public + internal traffic alike). NULL until the engine has
   *  seen the app once — the idle monitor seeds it on first evaluation so
   *  the sleep window never counts from the epoch. */
  last_request_at: string | null;
  requests_per_min: number; // rolling req/min from the engine's Traefik scrape; 0 when unobserved
  sticky: number; // 1 = sticky sessions (cookie-based) on the app's Traefik service
  rate_limit_rps: number; // public-router rate limit in req/s; 0 = unlimited
  ip_allowlist: string; // comma-separated IPs/CIDRs gating the public router; "" = open
  health_check_path: string; // active HTTP health-check path (e.g. /healthz); "" = off
  compress: number; // 1 = gzip/brotli compression on the public router
  public_port: number | null; // fleet-unique public raw TCP/UDP port on the panel IP; NULL = not exposed
  public_protocol: string; // 'tcp' | 'udp' — which pool public_port came from
  durability_class: string; // intent label: 'none' | 'standard' | 'high'; 'none' = no availability target
  max_per_host: number; // hard cap of this app's replicas per host; 0 = unlimited (soft affinity)
  min_locations: number; // minimum distinct provider locations replicas must span; 1 = no spread requirement
  placement_pool: string; // which servers.pool this app's replicas may be placed on; 'general' = default pool
  target: string; // deploy target tag: '' | 'production' | 'staging' | 'dev'
  target_of: number | null; // app id this is a staging/dev target of; NULL = standalone
  /** Monotonic desired-configuration revision. It changes independently of
   * source commits and is captured by every successful deployment. */
  config_revision: number;
  last_manifest_path: string | null;
  last_manifest_hash: string | null;
  last_manifest_applied_at: string | null;
  last_manifest_config_revision: number | null;
  rollout_requested_revision: number;
  rollout_requested_after_deployment_id: number;
  deletion_requested_at: string | null;
  github_webhook_repo: string;
};

/** Internal ingress port block: every app owns one port in
 *  [INTERNAL_PORT_BASE, INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT).
 *  The block size doubles as the hard fleet app cap. */
export const INTERNAL_PORT_BASE = 20000;
export const INTERNAL_PORT_COUNT = 200;

/** Per-app virtual IP block: every app owns one address in this range.
 *  Disjoint from ocd-net (10.0.0.0/16) and the Docker bridge (172.17.0.0/16). */
export const VIP_RANGE = "10.96.0.0/16";

/** Dotted quad for the nth address in VIP_RANGE. Valid indexes are 1-65534:
 *  0 is the network address, 65535 the broadcast address. */
export function vipFromIndex(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 65534) {
    throw new Error(`VIP index ${index} out of range (1-65534)`);
  }
  return `10.96.${Math.floor(index / 256)}.${index % 256}`;
}

/** Public raw TCP/UDP exposure pool: Traefik entrypoints are static-config-
 *  only, so the two 50-port blocks are pre-reserved fleet-wide (see
 *  traefikStaticConfig) and opened in the base Hetzner firewall rules. */
export const PUBLIC_TCP_PORT_BASE = 30000;
export const PUBLIC_TCP_PORT_COUNT = 50;
export const PUBLIC_UDP_PORT_BASE = 30050;
export const PUBLIC_UDP_PORT_COUNT = 50;

export type PublicProtocol = "tcp" | "udp";

/** Internal routing protocol on the app's internal entrypoint. */
export type InternalProtocol = "http" | "tcp";

export function publicPortRange(protocol: PublicProtocol): { base: number; count: number } {
  return protocol === "udp"
    ? { base: PUBLIC_UDP_PORT_BASE, count: PUBLIC_UDP_PORT_COUNT }
    : { base: PUBLIC_TCP_PORT_BASE, count: PUBLIC_TCP_PORT_COUNT };
}

/** bcrypt htpasswd entry hash for Traefik basicAuth ($2b$ — accepted by
 *  Traefik's htpasswd parser). "" in, "" out (auth disabled). */
export function hashAuthPassword(password: string): string {
  return password ? Bun.password.hashSync(password, { algorithm: "bcrypt" }) : "";
}

export function countApps(): number {
  const row = db.query("SELECT COUNT(*) as c FROM apps").get() as { c: number } | null;
  return row?.c ?? 0;
}

/** Lowest free port in the internal block. The partial unique index on
 *  apps.internal_port is the concurrency backstop; deleting an app row frees
 *  its port automatically. Ports are never reallocated on redeploy/move/scale
 *  because they live on the app row. */
export function allocateInternalPort(): number {
  const used = new Set(
    (db.query("SELECT internal_port FROM apps WHERE internal_port > 0").all() as Array<{ internal_port: number }>)
      .map((r) => r.internal_port),
  );
  for (let port = INTERNAL_PORT_BASE; port < INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(
    `Fleet limit of ${INTERNAL_PORT_COUNT} apps reached (internal port block ${INTERNAL_PORT_BASE}-${INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT - 1} is full). Destroy an app before deploying a new one.`,
  );
}

/** Lowest free address in the VIP block. Mirrors allocateInternalPort: the
 *  partial unique index on apps.virtual_ip is the concurrency backstop;
 *  deleting an app row frees its VIP automatically. VIPs are never
 *  reallocated on redeploy/move/scale because they live on the app row. */
export function allocateVirtualIp(): string {
  const used = new Set(
    (db.query("SELECT virtual_ip FROM apps WHERE virtual_ip != ''").all() as Array<{ virtual_ip: string }>)
      .map((r) => {
        const [, , c, d] = r.virtual_ip.split(".").map(Number);
        return c * 256 + d;
      }),
  );
  for (let index = 1; index <= 65534; index++) {
    if (!used.has(index)) return vipFromIndex(index);
  }
  throw new Error(`Virtual IP range ${VIP_RANGE} is exhausted. Destroy an app before deploying a new one.`);
}

/** Lowest free port in the protocol's public block. Mirrors
 *  allocateInternalPort: the partial unique index on apps.public_port is the
 *  concurrency backstop; deleting an app frees its port automatically. */
export function allocatePublicPort(protocol: PublicProtocol): number {
  const { base, count } = publicPortRange(protocol);
  const used = new Set(
    (db.query("SELECT public_port FROM apps WHERE public_port IS NOT NULL").all() as Array<{ public_port: number }>)
      .map((r) => r.public_port),
  );
  for (let port = base; port < base + count; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(
    `All ${count} public ${protocol.toUpperCase()} ports (${base}-${base + count - 1}) are taken. Unexpose an app before exposing a new one.`,
  );
}

export function getAppByPublicPort(port: number): AppRow | null {
  return db.query("SELECT * FROM apps WHERE public_port = ?").get(port) as AppRow | null;
}

/** Expose (port set) or unexpose (port null) an app on the public raw
 *  TCP/UDP pool. Pure Traefik-config change — callers re-sync ingress. */
export function updateAppPublicExposure(id: number, port: number | null, protocol: PublicProtocol): void {
  db.query("UPDATE apps SET public_port = ?, public_protocol = ? WHERE id = ?").run(port, protocol, id);
}

export type DnsRecordRow = {
  id: number;
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
};

export function getApps(serverId?: number): AppRow[] {
  if (serverId) {
    return db
      .query(
        "SELECT DISTINCT a.* FROM apps a JOIN replicas r ON r.app_id = a.id WHERE r.server_id = ? ORDER BY a.created_at DESC"
      )
      .all(serverId) as AppRow[];
  }
  return db
    .query("SELECT * FROM apps ORDER BY created_at DESC")
    .all() as AppRow[];
}

export function getApp(id: number): AppRow | null {
  return db.query("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | null;
}

export function getAppByName(name: string): AppRow | null {
  return db.query("SELECT * FROM apps WHERE name = ?").get(name) as AppRow | null;
}

export function getAppByDomain(domain: string): AppRow | null {
  return db
    .query("SELECT * FROM apps WHERE domain = ? LIMIT 1")
    .get(domain) as AppRow | null;
}

export type AppIngressSettings = {
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  compress?: boolean;
  /** Post-deploy HTTP probe on/off. Applies on the app's next (re)deploy or
   *  scale — unlike the rest of these, it isn't a live Traefik-config change. */
  health_check?: boolean;
  health_check_mode?: "http" | "container" | "exec" | "heartbeat" | "periodic_job";
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  image_ref?: string;
  build_cache_ref?: string;
};

type InsertAppFields = {
  name: string;
  domain: string;
  git_repo: string;
  git_branch?: string;
  dockerfile_path: string;
  docker_context?: string;
  container_port: number;
  env_vars: string;
  /** Write-only plaintext: hashed into auth_password_hash on insert, never
   *  stored. Empty/omitted = auth disabled. */
  auth_password?: string;
  environment_id?: number;
  env_projection?: string[] | null;
  public?: boolean;
  health_check?: boolean;
  /** Internal routing protocol. Omitted → derived from health_check (http when
   *  health_check is on, tcp when off) so callers that only set health_check
   *  keep the historical routing coupling. */
  internal_protocol?: InternalProtocol;
  /** Public raw TCP/UDP exposure: "auto" = lowest free port, number =
   *  specific port, omit/null = not exposed. */
  public_port?: number | "auto" | null;
  public_protocol?: PublicProtocol;
  durability_class?: string;
  max_per_host?: number;
  min_locations?: number;
  placement_pool?: string;
  target?: string;
  target_of?: number | null;
} & AppIngressSettings;

/** Resolve a deploy request's public exposure to a concrete port. Runs
 *  inside the insert transaction; re-checks range/freeness because the
 *  deploy op executes long after the API validated the request. */
function resolvePublicPort(app: InsertAppFields): number | null {
  if (app.public_port == null) return null;
  const protocol = app.public_protocol ?? "tcp";
  if (app.public_port === "auto") return allocatePublicPort(protocol);
  const rangeResult = validatePublicPort(app.public_port, protocol);
  if (!rangeResult.valid) throw new Error(rangeResult.error);
  if (getAppByPublicPort(app.public_port)) {
    throw new Error(`Public port ${app.public_port} is already taken by another app`);
  }
  return app.public_port;
}

// The single apps-table INSERT, shared by insertApp and
// insertAppWithFirstReplica (which wrap it in their own transactions —
// insertAppWithFirstReplica additionally inserts the first replica in the same
// tx). resolvePublicPort/allocateInternalPort run here so both paths allocate
// identically.
function insertAppRow(app: InsertAppFields): AppRow {
  const healthCheck = app.health_check_mode
    ? app.health_check_mode === "http"
    : (app.health_check ?? true);
  // Internal routing protocol is an explicit, first-class field (independent of
  // health_check): use the caller's value or default to "http". Raw-TCP apps
  // (e.g. databases) must set internal_protocol: "tcp" explicitly.
  const internalProtocol: InternalProtocol = app.internal_protocol ?? "http";
  return db
    .query(
      "INSERT INTO apps (name, domain, git_repo, git_branch, dockerfile_path, docker_context, source_mode, image_ref, build_cache_ref, container_port, env_vars, auth_password_hash, environment_id, env_projection, public, health_check, health_check_mode, health_check_command, health_check_file, health_check_max_age_seconds, internal_protocol, internal_port, virtual_ip, sticky, rate_limit_rps, ip_allowlist, health_check_path, compress, public_port, public_protocol, durability_class, max_per_host, min_locations, placement_pool, target, target_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      app.name,
      app.domain,
      app.git_repo,
      app.git_branch || "",
      app.dockerfile_path,
      app.docker_context || ".",
      app.image_ref ? "image" : "git",
      app.image_ref || "",
      app.build_cache_ref || "",
      app.container_port,
      app.env_vars,
      hashAuthPassword(app.auth_password || ""),
      app.environment_id ?? null,
      app.env_projection === undefined || app.env_projection === null
        ? null
        : JSON.stringify(app.env_projection),
      (app.public ?? true) ? 1 : 0,
      healthCheck ? 1 : 0,
      app.health_check_mode ?? (healthCheck ? "http" : "container"),
      app.health_check_command ?? "",
      app.health_check_file ?? "",
      app.health_check_max_age_seconds ?? 0,
      internalProtocol,
      allocateInternalPort(),
      allocateVirtualIp(),
      app.sticky ? 1 : 0,
      app.rate_limit_rps ?? 0,
      app.ip_allowlist ?? "",
      app.health_check_path ?? "",
      app.compress ? 1 : 0,
      resolvePublicPort(app),
      app.public_protocol ?? "tcp",
      app.durability_class ?? "none",
      app.max_per_host ?? 0,
      app.min_locations ?? 1,
      app.placement_pool ?? "general",
      app.target ?? "",
      app.target_of ?? null,
    ) as AppRow;
}

export function insertApp(app: InsertAppFields): AppRow {
  const tx = db.transaction(() => insertAppRow(app));
  return tx();
}

export function insertAppWithFirstReplica(
  app: InsertAppFields,
  serverId: number,
): { app: AppRow; replica: ReplicaRow } {
  const tx = db.transaction(() => {
    const appRow = insertAppRow(app);
    const hostPort = nextReplicaHostPort(serverId);
    const replicaRow = db
      .query(
        "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(appRow.id, serverId, hostPort, app.name, "deploying") as ReplicaRow;
    return { app: appRow, replica: replicaRow };
  });
  return tx();
}

export function getServersForApp(appId: number): ServerRow[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as ServerRow[];
}

/**
 * Returns true iff the server has at least one running (non-stopped) replica.
 * A replica row with status = 'stopped' is a light-sleep anchor, not a
 * running tenant — such servers are still materialized on the provider but
 * are doing no work.
 */
export function hasRunningReplicas(serverId: number): boolean {
  const row = db
    .query("SELECT COUNT(*) as c FROM replicas WHERE server_id = ? AND status != 'stopped'")
    .get(serverId) as { c: number } | null;
  return (row?.c ?? 0) > 0;
}

/**
 * Returns true iff the server has at least one replica row (of any status).
 * A server with only stopped replicas anchors the light-sleep state and must
 * survive gc — those rows are how wake knows where to `docker start`.
 */
export function hasAnyReplicas(serverId: number): boolean {
  const row = db
    .query("SELECT COUNT(*) as c FROM replicas WHERE server_id = ?")
    .get(serverId) as { c: number } | null;
  return (row?.c ?? 0) > 0;
}

export async function gcServerIfEmpty(serverId: number): Promise<void> {
  // This function records intent only. Provider deletion is owned by the
  // infrastructure reconciler so a transient provider error never makes the
  // DB forget a still-live server. Stopped replicas count as present because
  // they anchor the light-sleep fast wake path.
  const { clearServerGcRequest, requestServerGc } = await import("./servers.ts");
  if (hasAnyReplicas(serverId)) {
    clearServerGcRequest(serverId);
    return;
  }
  const { getServiceInstancesByServer } = await import("./services.ts");
  if (getServiceInstancesByServer(serverId).length > 0) {
    clearServerGcRequest(serverId);
    return;
  }
  const { getPanel } = await import("./panel.ts");
  if (getPanel()?.server_id === serverId) {
    clearServerGcRequest(serverId);
    return;
  }
  const sleepingRow = db.query("SELECT COUNT(*) as c FROM apps WHERE sleeping_server_id = ?").get(serverId) as { c: number } | null;
  const sleepingCount = sleepingRow?.c ?? 0;
  if (sleepingCount > 0) {
    clearServerGcRequest(serverId);
    return;
  }
  requestServerGc(serverId);
}

export function updateAppStatus(id: number, status: string): void {
  db.query("UPDATE apps SET status = ? WHERE id = ?").run(status, id);
}

export function requestAppRollout(id: number, revision?: number): void {
  db.query(
    `UPDATE apps SET
       rollout_requested_revision = COALESCE(?, config_revision),
       rollout_requested_after_deployment_id = COALESCE(
         (SELECT MAX(id) FROM deployment_history WHERE app_id = apps.id),
         0
       )
     WHERE id = ?`,
  ).run(revision ?? null, id);
}

export function clearAppRolloutRequest(id: number, throughRevision: number): void {
  db.query(
    `UPDATE apps SET
       rollout_requested_revision = 0,
       rollout_requested_after_deployment_id = 0
     WHERE id = ? AND rollout_requested_revision <= ?`,
  ).run(id, throughRevision);
}

export function markAppDeletionRequested(id: number): void {
  db.query(
    "UPDATE apps SET deletion_requested_at = COALESCE(deletion_requested_at, datetime('now')), status = 'destroying' WHERE id = ?",
  ).run(id);
}

export function updateAppPublicEndpointStatus(id: number, status: string, error = ""): void {
  db.query(
    "UPDATE apps SET public_endpoint_status = ?, public_endpoint_error = ?, public_endpoint_checked_at = datetime('now') WHERE id = ?",
  ).run(status, error, id);
}

export function updateAppSleepingState(id: number, serverId: number, hostPort: number): void {
  db.query("UPDATE apps SET sleeping_server_id = ?, sleeping_host_port = ? WHERE id = ?").run(serverId, hostPort, id);
}

export function clearAppSleepingState(id: number): void {
  db.query("UPDATE apps SET sleeping_server_id = NULL, sleeping_host_port = NULL WHERE id = ?").run(id);
}

export function touchAppLastRequest(id: number, atMs: number = Date.now()): void {
  db.query("UPDATE apps SET last_request_at = ? WHERE id = ?").run(new Date(atMs).toISOString(), id);
}

export function updateAppRequestRate(id: number, requestsPerMin: number): void {
  db.query("UPDATE apps SET requests_per_min = ? WHERE id = ?").run(requestsPerMin, id);
}

export function updateAppDeployedBy(id: number, userId: string): void {
  db.query("UPDATE apps SET deployed_by = ? WHERE id = ?").run(userId, id);
}

export function appendDeployLog(id: number, line: string): void {
  db.query(
    "UPDATE apps SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function getDeployLog(id: number): string {
  const row = db
    .query("SELECT deploy_log FROM apps WHERE id = ?")
    .get(id) as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deleteApp(id: number): void {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

export function insertDnsRecord(record: {
  app_id: number;
  zone_id: string;
  record_id: string;
  name: string;
  type: string;
  value: string;
}): DnsRecordRow {
  return db
    .query(
      "INSERT INTO dns_records (app_id, zone_id, record_id, name, type, value) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      record.app_id,
      record.zone_id,
      record.record_id,
      record.name,
      record.type,
      record.value
    ) as DnsRecordRow;
}

export function getDnsRecords(appId: number): DnsRecordRow[] {
  return db
    .query("SELECT * FROM dns_records WHERE app_id = ?")
    .all(appId) as DnsRecordRow[];
}

export function deleteDnsRecord(recordId: string): void {
  db.query("DELETE FROM dns_records WHERE record_id = ?").run(recordId);
}

export function updateAppEnvVars(id: number, envVars: string): void {
  db.query("UPDATE apps SET env_vars = ? WHERE id = ?").run(envVars, id);
}

export function getAppsByEnvironmentId(environmentId: number): AppRow[] {
  return db.query("SELECT * FROM apps WHERE environment_id = ?").all(environmentId) as AppRow[];
}

export function updateAppEnvironment(id: number, environmentId: number | null): void {
  db.query("UPDATE apps SET environment_id = ? WHERE id = ?").run(environmentId, id);
}

export function updateAppEnvProjection(id: number, projection: string[] | null): void {
  db.query("UPDATE apps SET env_projection = ? WHERE id = ?")
    .run(projection === null ? null : JSON.stringify(projection), id);
}

export function markAppsEnvironmentStale(environmentId: number): number {
  const result = db.query(
    "UPDATE apps SET environment_stale = 1 WHERE environment_id = ? AND status NOT IN ('destroying','cleanup_failed')",
  ).run(environmentId);
  return result.changes;
}

export function markAppsEnvironmentStaleForKeys(environmentId: number, changedKeys: string[]): number {
  if (changedKeys.length === 0) return 0;
  const changed = new Set(changedKeys);
  let count = 0;
  for (const app of getAppsByEnvironmentId(environmentId)) {
    const projection = parseAppEnvProjection(app);
    if (projection !== null && !projection.some((key) => changed.has(key))) continue;
    const result = db.query(
      "UPDATE apps SET environment_stale = 1 WHERE id = ? AND status NOT IN ('destroying','cleanup_failed')",
    ).run(app.id);
    count += result.changes;
  }
  return count;
}

export function markAppEnvironmentFresh(id: number): void {
  db.query("UPDATE apps SET environment_stale = 0 WHERE id = ?").run(id);
}

/** NULL means legacy/all. Invalid stored JSON also fails open to all so an
 *  upgrade cannot silently remove variables from a running app. */
export function parseAppEnvProjection(app: Pick<AppRow, "env_projection">): string[] | null {
  if (app.env_projection == null) return null;
  try {
    const parsed = JSON.parse(app.env_projection);
    return Array.isArray(parsed) && parsed.every((key) => typeof key === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function updateAppContainerPort(id: number, port: number): void {
  db.query("UPDATE apps SET container_port = ? WHERE id = ?").run(port, id);
}

/** Update the build source used by later code-only redeploys. */
export function updateAppBuildSource(
  id: number,
  fields: { gitRepo: string; gitBranch: string; dockerfilePath: string; dockerContext: string },
): void {
  db.query(
    "UPDATE apps SET git_repo = ?, git_branch = ?, dockerfile_path = ?, docker_context = ? WHERE id = ?",
  ).run(fields.gitRepo, fields.gitBranch, fields.dockerfilePath, fields.dockerContext, id);
}

export function updateAppArtifactAndHealth(
  id: number,
  fields: {
    imageRef: string;
    buildCacheRef: string;
    healthMode: string;
    healthCommand: string;
    healthFile: string;
    healthMaxAgeSeconds: number;
  },
): void {
  db.query(
    `UPDATE apps SET source_mode = ?, image_ref = ?, build_cache_ref = ?,
       health_check_mode = ?, health_check_command = ?, health_check_file = ?,
       health_check_max_age_seconds = ? WHERE id = ?`,
  ).run(
    fields.imageRef ? "image" : "git",
    fields.imageRef,
    fields.buildCacheRef,
    fields.healthMode,
    fields.healthCommand,
    fields.healthFile,
    fields.healthMaxAgeSeconds,
    id,
  );
}

/** Record provenance after an explicit manifest apply. This metadata is not
 * itself runtime configuration and therefore does not bump config_revision. */
export function recordAppManifestApplied(id: number, path: string, hash: string): void {
  db.query(
    "UPDATE apps SET last_manifest_path = ?, last_manifest_hash = ?, last_manifest_applied_at = datetime('now'), last_manifest_config_revision = config_revision WHERE id = ?",
  ).run(path, hash, id);
}

export function updateAppDomain(id: number, domain: string): void {
  db.query("UPDATE apps SET domain = ? WHERE id = ?").run(domain, id);
}

/** Persist an app's volume pointer. `attached` records provenance: false (the
 *  default) = a volume we CREATED (deleted on destroy); true = an EXISTING volume
 *  ATTACHED via attach_existing_volume (detached-not-deleted on destroy). Callers
 *  that CLEAR the volume (empty ids) leave attached at its harmless default. */
export function updateAppVolume(id: number, volumeId: string, volumeMount: string, attached = false): void {
  db.query("UPDATE apps SET volume_id = ?, volume_mount = ?, volume_attached = ? WHERE id = ?")
    .run(volumeId, volumeMount, attached ? 1 : 0, id);
}

export function updateAppExtraVolumes(id: number, extraVolumes: string[]): void {
  db.query("UPDATE apps SET extra_volumes = ? WHERE id = ?").run(JSON.stringify(extraVolumes), id);
}

/**
 * Parse the `apps.extra_volumes` JSON column into a list of "host:container"
 * mount specs. Tolerates malformed/legacy values (returns []) and filters out
 * any non-string entries so a corrupt row can never inject a bad `-v` flag.
 */
export function parseExtraVolumes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Set the per-app memory ceiling in MB. 0 = use the platform default. Applied
 *  to the container on the next (re)deploy / scale operation. */
export function updateAppMemory(id: number, memoryMb: number): void {
  db.query("UPDATE apps SET memory_mb = ? WHERE id = ?").run(memoryMb, id);
}

/** Set the per-app CPU ceiling in cores (fractional allowed). 0 = use the
 *  platform default. Applied to the container on the next (re)deploy / scale. */
export function updateAppCpu(id: number, cpuLimit: number): void {
  db.query("UPDATE apps SET cpu_limit = ? WHERE id = ?").run(cpuLimit, id);
}

/** Set (or clear) the app password. Takes write-only plaintext, stores only the
 *  bcrypt hash — a non-empty `authPassword` enables basic auth, "" disables it.
 *  Callers re-sync ingress after persisting (pure Traefik-config change). */
export function updateAppAuthPassword(id: number, authPassword: string): void {
  db.query("UPDATE apps SET auth_password_hash = ? WHERE id = ?").run(
    hashAuthPassword(authPassword),
    id,
  );
}

export function updateAppPublic(id: number, isPublic: boolean): void {
  db.query("UPDATE apps SET public = ? WHERE id = ?").run(isPublic ? 1 : 0, id);
}

/** Set the internal routing protocol ('http' | 'tcp'). Pure Traefik-config
 *  change for the routing itself; the app's OCD_INTERNAL_URL scheme only
 *  refreshes on its next (re)deploy. Callers re-sync ingress after persisting. */
export function updateAppInternalProtocol(id: number, protocol: InternalProtocol): void {
  db.query("UPDATE apps SET internal_protocol = ? WHERE id = ?").run(protocol, id);
}

export function updateAppWebhook(
  id: number,
  enabled: boolean,
  secret: string,
  branch: string,
  githubWebhookId: string,
  path: string = "",
  waitForCi: boolean = false,
  staging: boolean = false
): void {
  db.query(
    "UPDATE apps SET webhook_enabled = ?, webhook_secret = ?, webhook_branch = ?, webhook_path = ?, github_webhook_id = ?, webhook_wait_for_ci = ?, webhook_staging = ? WHERE id = ?"
  ).run(enabled ? 1 : 0, secret, branch, path, githubWebhookId, waitForCi ? 1 : 0, staging ? 1 : 0, id);
}

/** Persist the repository before touching GitHub so a crash between remote
 * creation and id persistence still leaves enough ownership information for
 * the next pass to find and converge the hook. */
export function updateAppWebhookProviderIdentity(id: number, repo: string, webhookId?: string): void {
  if (webhookId === undefined) {
    db.query("UPDATE apps SET github_webhook_repo = ? WHERE id = ?").run(repo, id);
  } else {
    db.query(
      "UPDATE apps SET github_webhook_repo = ?, github_webhook_id = ? WHERE id = ?",
    ).run(repo, webhookId, id);
  }
}

export function updateAppWebhookWaitForCi(id: number, waitForCi: boolean): void {
  db.query("UPDATE apps SET webhook_wait_for_ci = ? WHERE id = ?").run(waitForCi ? 1 : 0, id);
}

/** Select the environment the webhook staging sibling deploys with, or null to
 *  turn staging off. The legacy webhook_staging flag is kept in sync so readers
 *  that only check "is staging on" keep working. */
export function updateAppWebhookStagingEnvironment(id: number, environmentId: number | null): void {
  db.query("UPDATE apps SET webhook_staging_environment_id = ?, webhook_staging = ? WHERE id = ?")
    .run(environmentId, environmentId != null ? 1 : 0, id);
}

export type AppScalingUpdate = {
  desired_replicas?: number;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_enabled?: boolean;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  autoscale_req_threshold?: number;
  scale_to_zero_after?: number;
  last_scale_at?: string;
};

export function updateAppScaling(id: number, fields: AppScalingUpdate): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (fields.desired_replicas !== undefined) { sets.push("desired_replicas = ?"); values.push(fields.desired_replicas); }
  if (fields.min_replicas !== undefined) { sets.push("min_replicas = ?"); values.push(fields.min_replicas); }
  if (fields.max_replicas !== undefined) { sets.push("max_replicas = ?"); values.push(fields.max_replicas); }
  if (fields.autoscale_enabled !== undefined) { sets.push("autoscale_enabled = ?"); values.push(fields.autoscale_enabled ? 1 : 0); }
  if (fields.autoscale_cpu_threshold !== undefined) { sets.push("autoscale_cpu_threshold = ?"); values.push(fields.autoscale_cpu_threshold); }
  if (fields.autoscale_mem_threshold !== undefined) { sets.push("autoscale_mem_threshold = ?"); values.push(fields.autoscale_mem_threshold); }
  if (fields.autoscale_cooldown !== undefined) { sets.push("autoscale_cooldown = ?"); values.push(fields.autoscale_cooldown); }
  if (fields.autoscale_req_threshold !== undefined) { sets.push("autoscale_req_threshold = ?"); values.push(fields.autoscale_req_threshold); }
  if (fields.scale_to_zero_after !== undefined) { sets.push("scale_to_zero_after = ?"); values.push(fields.scale_to_zero_after); }
  if (fields.last_scale_at !== undefined) { sets.push("last_scale_at = ?"); values.push(fields.last_scale_at); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** Partial update of the app's durability/placement-spread intent. Mirrors
 *  updateAppScaling: only the provided fields are written. durability_class is
 *  the intent label ('none' | 'standard' | 'high'); max_per_host is the hard
 *  per-host replica cap (0 = unlimited); min_locations is the minimum distinct
 *  provider locations replicas must span. */
export function updateAppDurability(id: number, fields: {
  durability_class?: string;
  max_per_host?: number;
  min_locations?: number;
}): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (fields.durability_class !== undefined) { sets.push("durability_class = ?"); values.push(fields.durability_class); }
  if (fields.max_per_host !== undefined) { sets.push("max_per_host = ?"); values.push(fields.max_per_host); }
  if (fields.min_locations !== undefined) { sets.push("min_locations = ?"); values.push(fields.min_locations); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** Set which servers.pool this app's replicas may be placed on. */
export function updateAppPlacementPool(id: number, pool: string): void {
  db.query("UPDATE apps SET placement_pool = ? WHERE id = ?").run(pool, id);
}

/** Distinct, non-empty placement pools any app is currently targeting. */
export function getDistinctPlacementPools(): string[] {
  return (db.query("SELECT DISTINCT placement_pool FROM apps WHERE placement_pool <> ''").all() as { placement_pool: string }[])
    .map((r) => r.placement_pool);
}

/** Mark an app as a staging/dev target of another app (or clear it with
 *  targetOf = null) and set its deploy-target tag in the same write. */
export function setAppTarget(id: number, targetOf: number | null, target: string): void {
  db.query("UPDATE apps SET target_of = ?, target = ? WHERE id = ?").run(targetOf, target, id);
}

/** Persist a stack member's `needs` edges (member keys from the manifest), or
 *  clear them with `needs = null`. Written by deploy_stack alongside
 *  setAppStack; read by stack-wide ops that must act in dependency order. */
export function setAppStackNeeds(appId: number, needs: string[] | null): void {
  const json = needs && needs.length > 0 ? JSON.stringify(needs) : null;
  db.query("UPDATE apps SET stack_needs = ? WHERE id = ?").run(json, appId);
}

/** Parsed `stack_needs` for an app row — [] when unset, malformed, or the app
 *  predates migration 84. Never throws: ordering degrades to "no edges". */
export function parseStackNeeds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch { return []; }
}

/** The staging/dev children of a prod app — apps whose target_of points at it. */
export function getAppTargets(appId: number): AppRow[] {
  return db
    .query("SELECT * FROM apps WHERE target_of = ? ORDER BY created_at DESC")
    .all(appId) as AppRow[];
}

/** The app's staging sibling (target='staging', target_of=appId), or null. The
 *  webhook staging flow deploys to and promotes from exactly this row. */
export function getStagingSibling(appId: number): AppRow | null {
  return (db
    .query("SELECT * FROM apps WHERE target_of = ? AND target = 'staging' ORDER BY created_at ASC LIMIT 1")
    .get(appId) as AppRow | undefined) ?? null;
}

/** Partial update of the per-app ingress settings (sticky sessions, rate
 *  limit, IP allowlist, health-check path, compression). Values are rendered
 *  into Traefik dynamic config — callers re-sync ingress after persisting. */
export function updateAppIngressSettings(id: number, fields: AppIngressSettings): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (fields.sticky !== undefined) { sets.push("sticky = ?"); values.push(fields.sticky ? 1 : 0); }
  if (fields.rate_limit_rps !== undefined) { sets.push("rate_limit_rps = ?"); values.push(fields.rate_limit_rps); }
  if (fields.ip_allowlist !== undefined) { sets.push("ip_allowlist = ?"); values.push(fields.ip_allowlist); }
  if (fields.health_check_path !== undefined) { sets.push("health_check_path = ?"); values.push(fields.health_check_path); }
  if (fields.compress !== undefined) { sets.push("compress = ?"); values.push(fields.compress ? 1 : 0); }
  if (fields.health_check !== undefined) { sets.push("health_check = ?"); values.push(fields.health_check ? 1 : 0); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function nextReplicaHostPort(serverId: number): number {
  const BASE_PORT = 10000;
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM replicas WHERE server_id = ?")
    .get(serverId) as { max_port: number | null } | null;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}
