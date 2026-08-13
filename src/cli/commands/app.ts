import { get, post, resolveApp, type App } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RESET, table } from "../format.ts";

type AppDetail = App & {
  environment_name?: string | null;
  environment_id?: number | null;
  public?: boolean | number;
  memory_mb?: number;
  cpu_limit?: number;
  internal_protocol?: string;
  webhook_enabled?: boolean | number;
  webhook_branch?: string;
  webhook_path?: string;
  webhook_paths?: string[] | null;
  webhook_paths_ignore?: string[];
  webhook_wait_for_ci?: boolean | number;
  webhook_staging_environment_id?: number | null;
  autoscale_enabled?: boolean | number;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  autoscale_req_threshold?: number;
  scale_to_zero_after?: number;
  config_revision?: number;
  source_mode?: string;
  image_ref?: string;
  build_cache_ref?: string;
  health_check_mode?: string;
  health_check?: boolean | number;
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  volume_id?: string;
  volume_mount?: string;
  desired_volume_id?: string;
  desired_volume_size?: number;
  desired_volume_path?: string;
  last_webhook_head?: string | null;
  last_webhook_received_at?: string | null;
  last_webhook_evaluated_at?: string | null;
  last_webhook_ci_result?: string | null;
  last_matching_paths?: string[];
  last_decision?: string | null;
  last_evaluated_commit?: string | null;
  last_successfully_deployed_commit?: string | null;
};

export type ParsedFlags = {
  positional: string[];
  values: Map<string, string>;
  switches: Set<string>;
};

export function parseAppFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) switches.add(arg.slice(2));
    else values.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return { positional, values, switches };
}

function parseNumber(value: string, flag: string, opts: { integer?: boolean; min?: number; max?: number } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) ||
      (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) {
    throw new Error(`Invalid --${flag} value: ${value}`);
  }
  return n;
}

function requireAppName(parsed: ParsedFlags, usage: string): string {
  const name = parsed.positional[0];
  if (!name) throw new Error(`Usage: ${usage}`);
  return name;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function followNamedOp(
  opId: number | undefined,
  success: string,
  failure: string,
): Promise<void> {
  if (!opId) {
    console.log(`${GREEN}${success}${RESET}`);
    return;
  }
  const result = await followOp(opId);
  if (!result.ok) throw new Error(`${failure}: ${result.error || "unknown error"}`);
  console.log(`${GREEN}${success}${RESET}`);
}

async function showApp(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  if (parsed.positional.length > 1) throw new Error(`Unexpected argument: ${parsed.positional[1]}`);
  const unknownSwitch = [...parsed.switches].find((flag) => flag !== "storage");
  if (unknownSwitch) throw new Error(`Unknown option: --${unknownSwitch}`);
  const valueFlag = [...parsed.values.keys()][0];
  if (valueFlag) throw new Error(`Unknown option: --${valueFlag}`);
  const app = await resolveApp(requireAppName(parsed, "ocd app show <app>")) as AppDetail;
  table(["Field", "Value"], [
    ["ID", String(app.id)],
    ["Name", app.name],
    ["Status", app.status],
    ["Repository", app.git_repo || "-"],
    ["Source mode", app.source_mode || "git"],
    ["Immutable image", app.image_ref || "-"],
    ["Build cache", app.build_cache_ref || "-"],
    ["Domain", app.domain || "-"],
    ["Public", String(!!app.public)],
    ["Container port", String(app.container_port ?? "-")],
    ["Internal protocol", app.internal_protocol || "http"],
    ["Environment", app.environment_name || (app.environment_id ? `#${app.environment_id}` : "-")],
    ["Desired replicas", String(app.desired_replicas ?? "-")],
    ["Memory MB", String(app.memory_mb ?? "-")],
    ["CPU cores", String(app.cpu_limit ?? "-")],
    ["Config revision", String(app.config_revision ?? "-")],
    ["Volume intent", (app.desired_volume_size ?? 0) < 0
      ? "legacy; deploy an explicit manifest"
      : (app.desired_volume_size ?? 0) > 0
      ? `${app.desired_volume_id ? `adopt ${app.desired_volume_id}` : "managed"}, ${app.desired_volume_size} GB at ${app.desired_volume_path || "/data"}`
      : "none"],
    ["Volume actual", app.volume_id ? `${app.volume_id} at ${app.volume_mount}` : "none"],
    ["Health mode", app.health_check_mode || (app.health_check ? "http" : "container")],
    ["Health command", app.health_check_command || "-"],
    ["Health marker", app.health_check_file
      ? `${app.health_check_file} (max ${app.health_check_max_age_seconds}s)`
      : "-"],
    ["Webhook", app.webhook_enabled ? "enabled" : "disabled"],
  ]);
  if (parsed.switches.has("storage")) {
    const storage = await get<{
      current: { image_size_bytes: number; archive_size_bytes: number; transfer_size_bytes: number } | null;
      rollback: { image_size_bytes: number; archive_size_bytes: number; transfer_size_bytes: number } | null;
      reclaimable_image_bytes_upper_bound: number;
      caveat: string;
    }>(`/api/apps/${app.id}/storage`);
    const size = (bytes?: number | null) => typeof bytes === "number" && bytes > 0
      ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
      : "unknown";
    console.log(`\n${BOLD}Image storage${RESET}`);
    table(["Asset", "Expanded", "Compressed archive", "Transferred"], [
      ["Current", size(storage.current?.image_size_bytes), size(storage.current?.archive_size_bytes), size(storage.current?.transfer_size_bytes)],
      ["Rollback", size(storage.rollback?.image_size_bytes), size(storage.rollback?.archive_size_bytes), size(storage.rollback?.transfer_size_bytes)],
      ["Reclaimable (upper bound)", size(storage.reclaimable_image_bytes_upper_bound), "-", "-"],
    ]);
    console.log(`${DIM}${storage.caveat}${RESET}`);
  }
}

async function reloadEnvironment(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app reload-env <app> --force"));
  if (!parsed.switches.has("force")) {
    throw new Error("Environment reload is explicit and disruptive; pass --force to continue");
  }
  const result = await post<{ op_id: number }>(`/api/apps/${app.id}/reload-env`, { force: true });
  await followNamedOp(result.op_id, `Reloaded environment for ${app.name}`, "Environment reload failed");
}

async function redeployExisting(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app redeploy <app>"));
  const result = await post<{ op_id: number }>(`/api/apps/${app.id}/redeploy`, {});
  await followNamedOp(result.op_id, `Redeployed ${app.name}`, "Redeploy failed");
}

type Deployment = {
  id: number;
  image_tag?: string;
  image_digest?: string;
  git_commit?: string;
  config_revision?: number;
  source?: string;
  status: string;
  created_at: string;
  deploy_log?: string;
};

async function deployments(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app deployments <app>"));
  const rows = await get<Deployment[]>(`/api/apps/${app.id}/deployments`);
  table(
    ["ID", "Image", "Digest", "Commit", "Config", "Source", "Status", "Date"],
    rows.map((d) => [
      String(d.id),
      d.image_tag || "-",
      d.image_digest ? d.image_digest.split("@sha256:").pop()!.slice(0, 12) : "-",
      d.git_commit?.slice(0, 12) || "-",
      `r${d.config_revision ?? 1}`,
      d.source || "manual",
      d.status,
      formatDate(d.created_at),
    ]),
  );
}

type Replica = {
  id: number;
  server_id: number;
  container_name: string;
  host_port?: number;
  status: string;
  cpu_percent?: number;
  memory_percent?: number;
  memory_used_mb?: number;
  memory_limit_mb?: number;
  created_at?: string;
};

async function replicas(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app replicas <app>"));
  const rows = await get<Replica[]>(`/api/apps/${app.id}/replicas`);
  table(
    ["ID", "Container", "Server", "Status", "CPU", "Memory", "Host port"],
    rows.map((r) => [
      String(r.id),
      r.container_name,
      String(r.server_id),
      r.status,
      r.cpu_percent == null ? "-" : `${r.cpu_percent.toFixed(1)}%`,
      r.memory_percent == null ? "-" : `${r.memory_percent.toFixed(1)}%`,
      String(r.host_port ?? "-"),
    ]),
  );
}

async function metrics(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app metrics <app> [--since=3600]"));
  const sinceRaw = parsed.values.get("since");
  if (!sinceRaw) {
    const rows = await get<Replica[]>(`/api/apps/${app.id}/metrics`);
    table(
      ["Replica", "Container", "CPU", "Memory", "Used / limit"],
      rows.map((r) => [
        String(r.id),
        r.container_name,
        r.cpu_percent == null ? "-" : `${r.cpu_percent.toFixed(1)}%`,
        r.memory_percent == null ? "-" : `${r.memory_percent.toFixed(1)}%`,
        r.memory_used_mb == null ? "-" : `${r.memory_used_mb.toFixed(0)} / ${r.memory_limit_mb?.toFixed(0) ?? "-"} MB`,
      ]),
    );
    return;
  }
  const since = parseNumber(sinceRaw, "since", { integer: true, min: 60, max: 86400 });
  const result = await get<{ samples: Array<{
    replica_id: number;
    cpu_percent: number;
    memory_percent: number;
    sampled_at: string;
  }> }>(`/api/apps/${app.id}/metrics/history?since=${since}`);
  table(
    ["Time", "Replica", "CPU", "Memory"],
    result.samples.map((s) => [
      formatDate(s.sampled_at),
      String(s.replica_id),
      `${s.cpu_percent.toFixed(1)}%`,
      `${s.memory_percent.toFixed(1)}%`,
    ]),
  );
}

async function availability(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app availability <app> [--window=86400]"));
  const raw = parsed.values.get("window") || "86400";
  const window = parseNumber(raw, "window", { integer: true, min: 1 });
  const result = await get<{
    uptimePct: number | null;
    mttrSeconds: number | null;
    sampleCount: number;
    lastMeetsTarget: boolean | null;
    current: {
      desired: number;
      running: number;
      distinctHosts: number;
      distinctLocations: number;
      meetsTarget: boolean;
    };
  }>(`/api/apps/${app.id}/availability?window=${window}`);
  table(["Metric", "Value"], [
    ["Window", `${window}s`],
    ["Uptime", result.uptimePct == null ? "-" : `${result.uptimePct.toFixed(3)}%`],
    ["MTTR", result.mttrSeconds == null ? "-" : `${result.mttrSeconds}s`],
    ["Samples", String(result.sampleCount)],
    ["Meets target now", String(result.current.meetsTarget)],
    ["Desired / running", `${result.current.desired} / ${result.current.running}`],
    ["Hosts / locations", `${result.current.distinctHosts} / ${result.current.distinctLocations}`],
  ]);
}

async function scalingEvents(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app scaling-events <app>"));
  const rows = await get<Array<{
    id: number;
    event_type: string;
    from_count: number;
    to_count: number;
    reason?: string;
    created_at: string;
  }>>(`/api/apps/${app.id}/scaling-events`);
  table(
    ["When", "Event", "From", "To", "Reason"],
    rows.map((e) => [
      formatDate(e.created_at),
      e.event_type,
      String(e.from_count),
      String(e.to_count),
      e.reason || "-",
    ]),
  );
}

async function staging(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app staging <app>"));
  const result = await get<{
    staging_enabled: boolean;
    staging_environment_id: number | null;
    prod_commit: string | null;
    sibling: {
      id: number;
      name: string;
      status: string;
      domain?: string;
      commit: string | null;
    } | null;
  }>(`/api/apps/${app.id}/staging`);
  table(["Field", "Value"], [
    ["Enabled", String(result.staging_enabled)],
    ["Environment", result.staging_environment_id == null ? "-" : `#${result.staging_environment_id}`],
    ["Production commit", result.prod_commit || "-"],
    ["Sibling", result.sibling ? `${result.sibling.name} (#${result.sibling.id})` : "-"],
    ["Sibling status", result.sibling?.status || "-"],
    ["Sibling commit", result.sibling?.commit || "-"],
    ["Preview domain", result.sibling?.domain || "-"],
  ]);
}

async function webhook(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [action, appName] = parsed.positional;
  if (action !== "status" || !appName) {
    throw new Error("Usage: ocd app webhook status <app>");
  }
  const app = await resolveApp(appName) as AppDetail;
  await staging([appName]);
  console.log();
  table(["Webhook", "Value"], [
    ["Status", app.webhook_enabled ? "enabled" : "disabled"],
    ["Branch", app.webhook_branch || "main"],
    ["Paths", app.webhook_paths?.length ? app.webhook_paths.join("\n") : "(all pushes)"],
    ["Paths ignore", app.webhook_paths_ignore?.length ? app.webhook_paths_ignore.join("\n") : "-"],
    ...(app.webhook_path ? [["Legacy path (deprecated)", app.webhook_path]] : []),
    ["Wait for CI", String(!!app.webhook_wait_for_ci)],
    ["Last received push", app.last_webhook_head ? `${app.last_webhook_head.slice(0, 12)} ${app.last_webhook_received_at || ""}`.trim() : "-"],
    ["Last evaluated commit", app.last_evaluated_commit?.slice(0, 12) || "-"],
    ["Last CI result", app.last_webhook_ci_result || "-"],
    ["Last matching paths", app.last_matching_paths?.join("\n") || "-"],
    ["Last decision", app.last_decision || "-"],
    ["Last successfully deployed commit", app.last_successfully_deployed_commit || "-"],
  ]);
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd app <command> [args]

  show <app> [--storage]        Show app configuration and optional image storage
  deployments <app>            List deployment history
  replicas <app>               List replicas and current resource use
  metrics <app> [--since=SEC]   Current metrics or sampled history
  availability <app>           Show trailing availability and placement
  scaling-events <app>         List recent manual/autoscale events
  staging <app>                Inspect the webhook staging sibling
  webhook status <app>         Inspect stored webhook configuration
  reload-env <app> --force     Recreate only this app from its immutable image
  redeploy <app>               Rebuild using stored source, environment, and stack ownership${RESET}`);
}

export async function app(args: string[]): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  switch (command) {
    case "show": return showApp(rest);
    case "deployments":
    case "history": return deployments(rest);
    case "replicas": return replicas(rest);
    case "metrics": return metrics(rest);
    case "availability": return availability(rest);
    case "scaling-events":
    case "events": return scalingEvents(rest);
    case "staging": return staging(rest);
    case "webhook": return webhook(rest);
    case "reload-env": return reloadEnvironment(rest);
    case "deploy":
    case "redeploy": return redeployExisting(rest);
    default: throw new Error(`Unknown app command: ${command}`);
  }
}
