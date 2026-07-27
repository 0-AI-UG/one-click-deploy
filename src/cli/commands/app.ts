import { get, post, put, resolveApp, type App } from "../api.ts";
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

function parseBoolean(value: string, flag: string): boolean {
  if (value === "true" || value === "on" || value === "1") return true;
  if (value === "false" || value === "off" || value === "0") return false;
  throw new Error(`--${flag} must be true or false`);
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
  const app = await resolveApp(requireAppName(parsed, "ocd app show <app>")) as AppDetail;
  table(["Field", "Value"], [
    ["ID", String(app.id)],
    ["Name", app.name],
    ["Status", app.status],
    ["Repository", app.git_repo || "-"],
    ["Domain", app.domain || "-"],
    ["Public", String(!!app.public)],
    ["Container port", String(app.container_port ?? "-")],
    ["Internal protocol", app.internal_protocol || "http"],
    ["Environment", app.environment_name || (app.environment_id ? `#${app.environment_id}` : "-")],
    ["Desired replicas", String(app.desired_replicas ?? "-")],
    ["Memory MB", String(app.memory_mb ?? "-")],
    ["CPU cores", String(app.cpu_limit ?? "-")],
    ["Config revision", String(app.config_revision ?? "-")],
    ["Webhook", app.webhook_enabled ? "enabled" : "disabled"],
  ]);
}

async function renameApp(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [name, newName] = parsed.positional;
  if (!name || !newName) throw new Error("Usage: ocd app rename <app> <new-name>");
  const app = await resolveApp(name);
  const result = await put<{ ok: boolean; op_id?: number }>(
    `/api/apps/${app.id}/rename`,
    { name: newName },
  );
  await followNamedOp(result.op_id, `Renamed ${app.name} to ${newName}`, "Rename failed");
}

type Deployment = {
  id: number;
  image_tag?: string;
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
    ["ID", "Image", "Commit", "Config", "Source", "Status", "Date"],
    rows.map((d) => [
      String(d.id),
      d.image_tag || "-",
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

export type SettingsBody = {
  container_port?: number;
  public?: boolean;
  memory_mb?: number;
  cpu_limit?: number;
};

export function parseSettingsBody(parsed: ParsedFlags): SettingsBody {
  const body: SettingsBody = {};
  const port = parsed.values.get("port");
  const publicValue = parsed.values.get("public");
  const memory = parsed.values.get("memory");
  const cpu = parsed.values.get("cpu");
  if (port !== undefined) body.container_port = parseNumber(port, "port", { integer: true, min: 1, max: 65535 });
  if (publicValue !== undefined) body.public = parseBoolean(publicValue, "public");
  if (memory !== undefined) body.memory_mb = parseNumber(memory, "memory", { integer: true, min: 0 });
  if (cpu !== undefined) body.cpu_limit = parseNumber(cpu, "cpu", { min: 0 });
  return body;
}

async function settings(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app settings <app> [--port=N] [--public=true|false] [--memory=MB] [--cpu=CORES]"));
  const body = parseSettingsBody(parsed);
  if (Object.keys(body).length === 0) throw new Error("Provide at least one app setting");
  const result = await post<{ ok: boolean; op_id?: number }>(`/api/apps/${app.id}/redeploy`, body);
  await followNamedOp(result.op_id, `Updated and redeployed ${app.name}`, "Settings rollout failed");
}

export type IngressBody = {
  auth_password?: string;
  sticky?: boolean;
  rate_limit_rps?: number;
  ip_allowlist?: string;
  health_check_path?: string;
  health_check?: boolean;
  compress?: boolean;
  public_port?: number | "auto" | null;
  public_protocol?: "tcp" | "udp";
  internal_protocol?: "http" | "tcp";
};

export function parseIngressBody(parsed: ParsedFlags): IngressBody {
  const body: IngressBody = {};
  const value = (name: string) => parsed.values.get(name);
  const protocol = value("internal-protocol");
  if (protocol !== undefined) {
    if (protocol !== "http" && protocol !== "tcp") throw new Error("--internal-protocol must be http or tcp");
    body.internal_protocol = protocol;
  }
  if (parsed.switches.has("disable-auth")) body.auth_password = "";
  const passwordEnv = value("auth-password-env");
  if (passwordEnv !== undefined) {
    if (body.auth_password !== undefined) throw new Error("Use only one of --auth-password-env and --disable-auth");
    const password = process.env[passwordEnv];
    if (!password) throw new Error(`Environment variable ${passwordEnv} is not set`);
    body.auth_password = password;
  }
  const sticky = value("sticky");
  if (sticky !== undefined) body.sticky = parseBoolean(sticky, "sticky");
  const rate = value("rate-limit");
  if (rate !== undefined) body.rate_limit_rps = parseNumber(rate, "rate-limit", { integer: true, min: 0, max: 1_000_000 });
  const allowlist = value("allowlist");
  if (allowlist !== undefined) body.ip_allowlist = allowlist;
  const path = value("health-path");
  if (path !== undefined) body.health_check_path = path;
  const health = value("health-check");
  if (health !== undefined) body.health_check = parseBoolean(health, "health-check");
  const compress = value("compress");
  if (compress !== undefined) body.compress = parseBoolean(compress, "compress");
  const publicPort = value("public-port");
  if (publicPort !== undefined) {
    body.public_port = publicPort === "off" ? null
      : publicPort === "auto" ? "auto"
      : parseNumber(publicPort, "public-port", { integer: true, min: 1, max: 65535 });
  }
  const publicProtocol = value("public-protocol");
  if (publicProtocol !== undefined) {
    if (publicProtocol !== "tcp" && publicProtocol !== "udp") throw new Error("--public-protocol must be tcp or udp");
    body.public_protocol = publicProtocol;
  }
  return body;
}

async function ingress(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const app = await resolveApp(requireAppName(parsed, "ocd app ingress <app> [options]"));
  const body = parseIngressBody(parsed);
  if (Object.keys(body).length === 0) throw new Error("Provide at least one ingress setting");
  const result = await put<{ ok: boolean; public_port: number | null; public_protocol: string }>(
    `/api/apps/${app.id}/ingress`,
    body,
  );
  console.log(`${GREEN}Updated ingress for ${app.name}${RESET}`);
  if ("public_port" in body) {
    console.log(`${DIM}Raw exposure: ${result.public_port == null ? "off" : `${result.public_protocol}/${result.public_port}`}${RESET}`);
  }
}

type Environment = { id: number; name: string };

async function resolveEnvironment(value: string): Promise<number> {
  const environments = await get<Environment[]>("/api/environments");
  const id = Number(value);
  const match = Number.isInteger(id)
    ? environments.find((env) => env.id === id)
    : environments.find((env) => env.name.toLowerCase() === value.toLowerCase());
  if (!match) throw new Error(`Environment not found: ${value}`);
  return match.id;
}

async function webhook(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [action, appName] = parsed.positional;
  if (!action || !appName) throw new Error("Usage: ocd app webhook <status|enable|set|disable> <app> [options]");
  const app = await resolveApp(appName) as AppDetail;
  if (action === "status") {
    await staging([appName]);
    console.log();
    table(["Webhook", "Value"], [
      ["Status", app.webhook_enabled ? "enabled" : "disabled"],
      ["Branch", app.webhook_branch || "main"],
      ["Path", app.webhook_path || "-"],
      ["Wait for CI", String(!!app.webhook_wait_for_ci)],
    ]);
    return;
  }
  if (action === "disable") {
    await post(`/api/apps/${app.id}/webhook/disable`);
    console.log(`${GREEN}Disabled webhook for ${app.name}${RESET}`);
    return;
  }

  const stagingValue = parsed.values.get("staging-env");
  const stagingEnvironmentId = stagingValue === undefined ? undefined
    : (stagingValue === "off" || stagingValue === "none" ? null : await resolveEnvironment(stagingValue));
  if (action === "enable") {
    const wait = parsed.values.get("wait-for-ci");
    await post(`/api/apps/${app.id}/webhook/enable`, {
      branch: parsed.values.get("branch") || "main",
      ...(parsed.values.has("path") ? { path: parsed.values.get("path") } : {}),
      ...(wait !== undefined ? { wait_for_ci: parseBoolean(wait, "wait-for-ci") } : {}),
      ...(stagingEnvironmentId !== undefined ? { staging_environment_id: stagingEnvironmentId } : {}),
    });
    console.log(`${GREEN}Enabled webhook for ${app.name}${RESET}`);
    return;
  }
  if (action === "set") {
    const wait = parsed.values.get("wait-for-ci");
    const body: { wait_for_ci?: boolean; staging_environment_id?: number | null } = {};
    if (wait !== undefined) body.wait_for_ci = parseBoolean(wait, "wait-for-ci");
    if (stagingEnvironmentId !== undefined) body.staging_environment_id = stagingEnvironmentId;
    if (Object.keys(body).length === 0) throw new Error("Provide --wait-for-ci or --staging-env");
    await post(`/api/apps/${app.id}/webhook/settings`, body);
    console.log(`${GREEN}Updated webhook for ${app.name}${RESET}`);
    return;
  }
  throw new Error(`Unknown webhook action: ${action}`);
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd app <command> [args]

  show <app>                    Show app configuration and runtime state
  rename <app> <new-name>       Rename an app and its managed resources
  deployments <app>            List deployment history
  replicas <app>               List replicas and current resource use
  metrics <app> [--since=SEC]   Current metrics or sampled history
  availability <app>           Show trailing availability and placement
  scaling-events <app>         List recent manual/autoscale events
  staging <app>                Inspect the webhook staging sibling
  settings <app> [options]     Update runtime settings and redeploy
  ingress <app> [options]      Narrow ingress update; unspecified fields stay
  webhook <action> <app>       Status, enable, update, or disable webhook

${DIM}Settings: --port=N --public=true|false --memory=MB --cpu=CORES
Ingress: --internal-protocol=http|tcp --auth-password-env=KEY --disable-auth
         --sticky=true|false --rate-limit=N --allowlist=CSV --health-path=/path
         --health-check=true|false --compress=true|false
         --public-port=off|auto|N --public-protocol=tcp|udp
Webhook enable: --branch=NAME --path=PREFIX --wait-for-ci=true|false
Webhook enable/set: --staging-env=<name|id|off>${RESET}`);
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
    case "rename": return renameApp(rest);
    case "deployments":
    case "history": return deployments(rest);
    case "replicas": return replicas(rest);
    case "metrics": return metrics(rest);
    case "availability": return availability(rest);
    case "scaling-events":
    case "events": return scalingEvents(rest);
    case "staging": return staging(rest);
    case "settings": return settings(rest);
    case "ingress": return ingress(rest);
    case "webhook": return webhook(rest);
    default: throw new Error(`Unknown app command: ${command}`);
  }
}
