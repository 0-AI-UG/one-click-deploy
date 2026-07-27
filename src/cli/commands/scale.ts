import { get, post, put, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RESET, table } from "../format.ts";
import { parseAppFlags, type ParsedFlags } from "./app.ts";

type ScalingApp = {
  id: number;
  name: string;
  status: string;
  desired_replicas: number;
  autoscale_enabled?: boolean | number;
  min_replicas?: number;
  max_replicas?: number;
  autoscale_cpu_threshold?: number;
  autoscale_mem_threshold?: number;
  autoscale_cooldown?: number;
  autoscale_req_threshold?: number;
  scale_to_zero_after?: number;
};

type PolicyBody = {
  autoscale_enabled: boolean;
  min_replicas: number;
  max_replicas: number;
  cpu_threshold: number;
  mem_threshold: number;
  cooldown: number;
  scale_to_zero_after: number;
  req_threshold: number;
};

function integer(value: string, flag: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${flag} must be an integer >= ${min}`);
  return n;
}

function bool(value: string, flag: string): boolean {
  if (["true", "on", "1"].includes(value)) return true;
  if (["false", "off", "0"].includes(value)) return false;
  throw new Error(`--${flag} must be true or false`);
}

function currentPolicy(app: ScalingApp): PolicyBody {
  return {
    autoscale_enabled: !!app.autoscale_enabled,
    min_replicas: app.min_replicas ?? 1,
    max_replicas: app.max_replicas ?? 3,
    cpu_threshold: app.autoscale_cpu_threshold ?? 70,
    mem_threshold: app.autoscale_mem_threshold ?? 80,
    cooldown: app.autoscale_cooldown ?? 300,
    scale_to_zero_after: app.scale_to_zero_after ?? 300,
    req_threshold: app.autoscale_req_threshold ?? 0,
  };
}

export function parsePolicyBody(parsed: ParsedFlags, current: PolicyBody): PolicyBody {
  const body = { ...current };
  const values = parsed.values;
  if (values.has("enabled")) body.autoscale_enabled = bool(values.get("enabled")!, "enabled");
  if (values.has("min")) body.min_replicas = integer(values.get("min")!, "min", 0);
  if (values.has("max")) body.max_replicas = integer(values.get("max")!, "max", 1);
  if (values.has("cpu")) body.cpu_threshold = integer(values.get("cpu")!, "cpu", 1);
  if (values.has("memory")) body.mem_threshold = integer(values.get("memory")!, "memory", 1);
  if (values.has("cooldown")) body.cooldown = integer(values.get("cooldown")!, "cooldown", 30);
  if (values.has("idle")) body.scale_to_zero_after = integer(values.get("idle")!, "idle", 60);
  if (values.has("requests")) body.req_threshold = integer(values.get("requests")!, "requests", 0);
  if (body.cpu_threshold > 100 || body.mem_threshold > 100) {
    throw new Error("--cpu and --memory must be between 1 and 100");
  }
  if (body.max_replicas < body.min_replicas) throw new Error("--max must be >= --min");
  return body;
}

async function scaleTo(appName: string, targetRaw: string, parsed: ParsedFlags): Promise<void> {
  const target = integer(targetRaw, "replicas", 0);
  const app = await resolveApp(appName);
  const serverRaw = parsed.values.get("server");
  // The API currently accepts server_id but its level-triggered convergence
  // path does not persist or consume it (and wake always uses the sleep
  // anchor). Refuse to imply placement control until backend desired placement
  // exists; use replica migration after convergence in the meantime.
  if (serverRaw !== undefined) {
    integer(serverRaw, "server", 1);
    throw new Error(
      "--server is not yet enforceable by the backend; scale first, then use `ocd scale migrate`",
    );
  }
  const result = await post<{ op_id: number | null; desired?: number; noop?: boolean }>(
    `/api/apps/${app.id}/scale`,
    { replicas: target },
  );
  if (result.op_id) {
    const followed = await followOp(result.op_id);
    if (!followed.ok) throw new Error(`Wake failed: ${followed.error || "unknown error"}`);
  }
  console.log(
    result.noop
      ? `${DIM}${app.name} is already at ${target} replicas${RESET}`
      : `${GREEN}Desired replicas for ${app.name}: ${target}${RESET}`,
  );
}

async function policy(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [action, appName] = parsed.positional;
  if (!action || !appName) throw new Error("Usage: ocd scale policy <show|set> <app> [options]");
  const app = await resolveApp(appName) as ScalingApp;
  const current = currentPolicy(app);
  if (action === "show") {
    table(["Setting", "Value"], [
      ["Enabled", String(current.autoscale_enabled)],
      ["Min / max", `${current.min_replicas} / ${current.max_replicas}`],
      ["CPU threshold", `${current.cpu_threshold}%`],
      ["Memory threshold", `${current.mem_threshold}%`],
      ["Requests/min/replica", String(current.req_threshold)],
      ["Cooldown", `${current.cooldown}s`],
      ["Scale-to-zero idle", `${current.scale_to_zero_after}s`],
    ]);
    return;
  }
  if (action !== "set") throw new Error(`Unknown policy action: ${action}`);
  const body = parsePolicyBody(parsed, current);
  await put(`/api/apps/${app.id}/scaling-policy`, body);
  console.log(`${GREEN}Updated autoscale policy for ${app.name}${RESET}`);
}

async function migrate(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [appName, replicaRaw] = parsed.positional;
  const targetRaw = parsed.values.get("to");
  if (!appName || !replicaRaw || !targetRaw) {
    throw new Error("Usage: ocd scale migrate <app> <replica-id> --to=<server-id>");
  }
  const app = await resolveApp(appName);
  const replicaId = integer(replicaRaw, "replica", 1);
  const targetServerId = integer(targetRaw, "to", 1);
  const replicas = await get<Array<{ id: number; status: string }>>(`/api/apps/${app.id}/replicas`);
  if (!replicas.some((replica) => replica.id === replicaId)) {
    throw new Error(`Replica #${replicaId} was not found for ${app.name}`);
  }
  const result = await post<{ op_id: number }>(
    `/api/apps/${app.id}/replicas/${replicaId}/migrate`,
    { target_server_id: targetServerId },
  );
  const followed = await followOp(result.op_id);
  if (!followed.ok) throw new Error(`Migration failed: ${followed.error || "unknown error"}`);
  console.log(`${GREEN}Migrated replica #${replicaId} to server #${targetServerId}${RESET}`);
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET}
  ocd scale <app> <replicas>
  ocd scale wake <app>
  ocd scale policy show <app>
  ocd scale policy set <app> [options]
  ocd scale migrate <app> <replica-id> --to=<server-id>

${DIM}Policy options: --enabled=true|false --min=N --max=N --cpu=PCT
                --memory=PCT --requests=N --cooldown=SEC --idle=SEC${RESET}`);
}

export async function scale(args: string[]): Promise<void> {
  if (!args[0] || ["help", "--help", "-h"].includes(args[0])) {
    usage();
    return;
  }
  if (args[0] === "policy") return policy(args.slice(1));
  if (args[0] === "migrate") return migrate(args.slice(1));
  if (args[0] === "wake") {
    const parsed = parseAppFlags(args.slice(1));
    const appName = parsed.positional[0];
    if (!appName) throw new Error("Usage: ocd scale wake <app>");
    return scaleTo(appName, "1", parsed);
  }
  const parsed = parseAppFlags(args);
  const [appName, target] = parsed.positional;
  if (!appName || target === undefined) throw new Error("Usage: ocd scale <app> <replicas>");
  return scaleTo(appName, target, parsed);
}
