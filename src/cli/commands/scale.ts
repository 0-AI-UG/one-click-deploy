import { get, post, resolveApp } from "../api.ts";
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

function currentPolicy(app: ScalingApp): PolicyBody {
  return {
    autoscale_enabled: !!app.autoscale_enabled,
    min_replicas: app.min_replicas ?? 1,
    max_replicas: app.max_replicas ?? 1,
    cpu_threshold: app.autoscale_cpu_threshold ?? 80,
    mem_threshold: app.autoscale_mem_threshold ?? 85,
    cooldown: app.autoscale_cooldown ?? 300,
    scale_to_zero_after: app.scale_to_zero_after ?? 0,
    req_threshold: app.autoscale_req_threshold ?? 0,
  };
}

async function wake(appName: string, parsed: ParsedFlags): Promise<void> {
  const app = await resolveApp(appName);
  const serverRaw = parsed.values.get("server");
  // The API currently accepts server_id but its level-triggered convergence
  // path does not persist or consume it (and wake always uses the sleep
  // anchor). Refuse to imply placement control until backend desired placement
  // exists; use replica migration after convergence in the meantime.
  if (serverRaw !== undefined) {
    integer(serverRaw, "server", 1);
    throw new Error(
      "--server is not supported for wake; use `ocd scale migrate` after the app wakes",
    );
  }
  const result = await post<{ op_id: number | null; noop?: boolean }>(
    `/api/apps/${app.id}/wake`,
  );
  if (result.op_id) {
    const followed = await followOp(result.op_id);
    if (!followed.ok) throw new Error(`Wake failed: ${followed.error || "unknown error"}`);
  }
  console.log(
    result.noop
      ? `${DIM}${app.name} is already awake${RESET}`
      : `${GREEN}Woke ${app.name}${RESET}`,
  );
}

async function policy(args: string[]): Promise<void> {
  const parsed = parseAppFlags(args);
  const [action, appName] = parsed.positional;
  if (action !== "show" || !appName) {
    throw new Error(
      "Usage: ocd scale policy show <app>\nScaling policy is configured in .ocd-deploy.json and applied with ocd deploy.",
    );
  }
  const app = await resolveApp(appName) as ScalingApp;
  const current = currentPolicy(app);
  table(["Setting", "Value"], [
    ["Enabled", String(current.autoscale_enabled)],
    ["Min / max", `${current.min_replicas} / ${current.max_replicas}`],
    ["CPU threshold", `${current.cpu_threshold}%`],
    ["Memory threshold", `${current.mem_threshold}%`],
    ["Requests/min/replica", String(current.req_threshold)],
    ["Cooldown", `${current.cooldown}s`],
    ["Scale-to-zero idle", `${current.scale_to_zero_after}s`],
  ]);
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
  ocd scale wake <app>
  ocd scale policy show <app>
  ocd scale migrate <app> <replica-id> --to=<server-id>

${DIM}Desired replicas and autoscaling policy are configured in
.ocd-deploy.json and applied with ocd deploy.${RESET}`);
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
    return wake(appName, parsed);
  }
  usage();
}
