import { get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, table, colorStatus } from "../format.ts";

interface Service {
  id: number;
  name: string;
  service_type: string;
  status: string;
  linked_environments?: { id: number; name: string }[];
}

interface CatalogService {
  type: string;
  label: string;
  versions: string[];
  defaultVolumeSize: number;
  stateless?: boolean;
  description?: string;
}

type Environment = {
  id: number;
  name: string;
};

export type ServiceCreateOptions = {
  name: string;
  serviceType: string;
  version?: string;
  volumeSize?: number;
  environment?: string;
  envPrefix?: string;
  domain?: string;
  envOverrides: Record<string, string>;
};

export function parseServiceCreateArgs(
  args: string[],
): { ok: true; value: ServiceCreateOptions } | { ok: false; error: string } {
  let name = "";
  let serviceType = "";
  let version: string | undefined;
  let volumeSize: number | undefined;
  let environment: string | undefined;
  let envPrefix: string | undefined;
  let domain: string | undefined;
  const envOverrides: Record<string, string> = {};

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return { ok: false, error: "help" };
    if (arg.startsWith("--type=")) serviceType = arg.slice(7);
    else if (arg.startsWith("--version=")) version = arg.slice(10);
    else if (arg.startsWith("--volume-size=")) {
      const raw = arg.slice(14);
      volumeSize = Number(raw);
      if (!Number.isFinite(volumeSize) || volumeSize < 1) {
        return { ok: false, error: `Invalid --volume-size "${raw}" (expected a positive number)` };
      }
    } else if (arg.startsWith("--env=")) environment = arg.slice(6);
    else if (arg.startsWith("--env-prefix=")) envPrefix = arg.slice(13);
    else if (arg.startsWith("--domain=")) domain = arg.slice(9);
    else if (arg.startsWith("--set=")) {
      const pair = arg.slice(6);
      const eq = pair.indexOf("=");
      if (eq < 1) return { ok: false, error: `Invalid --set "${pair}" (expected KEY=VALUE)` };
      envOverrides[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `Unknown option: ${arg}` };
    } else if (!name) name = arg;
    else return { ok: false, error: `Unexpected argument: ${arg}` };
  }

  if (!name) return { ok: false, error: "Service name is required" };
  if (!serviceType) return { ok: false, error: "--type is required" };
  return {
    ok: true,
    value: {
      name,
      serviceType,
      version,
      volumeSize,
      environment,
      envPrefix,
      domain,
      envOverrides,
    },
  };
}

function createUsage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd service create <name> --type=<catalog-type> [options]

Create a standalone managed service. The same type, version, volume and
environment overrides are available under services.<key> in ocd-stack.json.

${BOLD}Options:${RESET}
  --type=<type>              Catalog type, e.g. postgresql, redis, mysql
  --version=<tag>            Catalog-supported image version
  --volume-size=<gb>         Persistent volume size in GB
  --set=KEY=VALUE            Override a service environment value (repeatable)
  --env=<name|id>            Inject credentials into an existing environment
  --env-prefix=<prefix>      Credential prefix in that environment
  --domain=<domain>          Custom domain for HTTP-facing services`);
}

async function resolveEnvironment(ref: string): Promise<Environment> {
  const environments = await get<Environment[]>("/api/environments");
  const byId = /^\d+$/.test(ref)
    ? environments.find((environment) => environment.id === Number(ref))
    : undefined;
  const found =
    byId ?? environments.find((environment) => environment.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new Error(`Environment not found: ${ref}`);
  return found;
}

async function createService(args: string[]): Promise<void> {
  const parsed = parseServiceCreateArgs(args);
  if (!parsed.ok) {
    createUsage();
    if (parsed.error !== "help") throw new Error(parsed.error);
    return;
  }
  const opts = parsed.value;
  const environment = opts.environment
    ? await resolveEnvironment(opts.environment)
    : undefined;
  if (opts.envPrefix && !environment) {
    throw new Error("--env-prefix requires --env");
  }

  const body = {
    name: opts.name,
    service_type: opts.serviceType,
    version: opts.version,
    volume_size: opts.volumeSize,
    env_overrides:
      Object.keys(opts.envOverrides).length > 0 ? opts.envOverrides : undefined,
    environment_id: environment?.id,
    env_prefix: opts.envPrefix,
    domain: opts.domain,
  };

  console.log(`Deploying service ${BOLD}${opts.name}${RESET} (${opts.serviceType})...`);
  if (environment) console.log(`${DIM}Environment:${RESET} ${environment.name}`);
  const { op_id } = await post<{ op_id: number }>("/api/services/deploy", body);
  const result = await followOp(op_id);
  if (!result.ok) throw new Error(result.error || "Service deployment failed");
  console.log(`\n${GREEN}Service deploy complete!${RESET}`);
}

export async function services(args: string[] = []): Promise<void> {
  if (args[0] === "create" || args[0] === "deploy") {
    await createService(args.slice(1));
    return;
  }
  if (args[0] === "catalog") {
    const catalog = await get<CatalogService[]>("/api/services/catalog");
    table(
      ["Type", "Label", "Default version", "Volume", "Description"],
      catalog.map((entry) => [
        entry.type,
        entry.label,
        entry.versions[0] || "-",
        entry.stateless ? "none" : `${entry.defaultVolumeSize} GB`,
        entry.description || "-",
      ]),
    );
    return;
  }
  if (args.length > 0 && !["list", "ls"].includes(args[0])) {
    console.error(`${RED}Unknown service command: ${args[0]}${RESET}`);
    createUsage();
    return;
  }
  const list = await get<Service[]>("/api/services");

  table(
    ["Name", "Type", "Status", "Injected Into"],
    list.map((s) => [
      s.name,
      s.service_type,
      colorStatus(s.status),
      s.linked_environments?.map((e) => e.name).join(", ") || "-",
    ]),
  );
}
