import { del, get, post } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RED, RESET, table, colorStatus } from "../format.ts";
import { webConfirm, withWebConfirmation } from "../confirm.ts";
import { readSetValuesFromStdin } from "../stdin-values.ts";

interface Service {
  id: number;
  name: string;
  service_type: string;
  version?: string;
  status: string;
  credentials?: Record<string, unknown>;
  instances?: ServiceInstance[];
  primary_instance?: ServiceInstance | null;
  linked_environments?: { id: number; name: string }[];
}

interface ServiceInstance {
  id: number;
  server_id: number;
  server_name?: string;
  container_name: string;
  host_port: number;
  status: string;
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
    } else if (arg === "--sets-stdin") {
      // Parsed asynchronously by createService so sensitive overrides stay
      // out of the process argument list.
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
  if (args.includes("--sets-stdin")) {
    for (const pair of (await readSetValuesFromStdin()).sets) {
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`Invalid stdin set value (expected KEY=VALUE): ${pair}`);
      opts.envOverrides[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
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
  const { op_id } = await withWebConfirmation((headers) =>
    post<{ op_id: number }>("/api/services/deploy", body, headers)
  );
  const result = await followOp(op_id);
  if (!result.ok) throw new Error(result.error || "Service deployment failed");
  console.log(`\n${GREEN}Service deploy complete!${RESET}`);
}

async function resolveService(ref: string): Promise<Service> {
  const services = await get<Service[]>("/api/services");
  const numeric = /^\d+$/.test(ref)
    ? services.find((service) => service.id === Number(ref))
    : undefined;
  const service =
    numeric ?? services.find((entry) => entry.name.toLowerCase() === ref.toLowerCase());
  if (!service) {
    throw new Error(
      `Service not found: ${ref}. Available: ${services.map((entry) => entry.name).join(", ") || "(none)"}`,
    );
  }
  return service;
}

async function getServiceDetail(ref: string): Promise<Service> {
  const service = await resolveService(ref);
  return get<Service>(`/api/services/${service.id}`);
}

function maskCredential(key: string, value: unknown, showSecrets: boolean): string {
  if (value == null || value === "") return "-";
  const sensitive = /password|token|secret|connection_url/i.test(key);
  return sensitive && !showSecrets ? "••••••••" : String(value);
}

async function showService(ref: string, showSecrets: boolean): Promise<void> {
  const service = await getServiceDetail(ref);
  console.log(`${BOLD}${service.name}${RESET} ${DIM}(id: ${service.id})${RESET}`);
  console.log(`${DIM}Type:${RESET} ${service.service_type}  ${DIM}Version:${RESET} ${service.version || "-"}  ${DIM}Status:${RESET} ${colorStatus(service.status)}`);
  if (service.instances?.length) {
    console.log(`\n${BOLD}Instances${RESET}`);
    table(
      ["ID", "Container", "Server", "Port", "Status"],
      service.instances.map((instance) => [
        String(instance.id),
        instance.container_name,
        instance.server_name || String(instance.server_id),
        String(instance.host_port),
        colorStatus(instance.status),
      ]),
    );
  }
  const credentials = Object.entries(service.credentials || {});
  if (credentials.length) {
    console.log(`\n${BOLD}Connection${RESET}`);
    table(
      ["Key", "Value"],
      credentials.map(([key, value]) => [key, maskCredential(key, value, showSecrets)]),
    );
    if (!showSecrets) {
      console.log(`${DIM}Sensitive values are masked. Use --show-secrets only in a trusted terminal.${RESET}`);
    }
  }
  if (service.linked_environments?.length) {
    console.log(
      `\n${BOLD}Injected into:${RESET} ` +
        service.linked_environments.map((environment) => environment.name).join(", "),
    );
  }
}

async function runServiceOp(
  ref: string,
  action: "restart" | "pause" | "unpause",
): Promise<void> {
  const service = await resolveService(ref);
  const { op_id } = await post<{ op_id: number }>(`/api/services/${service.id}/${action}`);
  console.log(`${action[0].toUpperCase()}${action.slice(1)}ing ${BOLD}${service.name}${RESET}…`);
  const result = await followOp(op_id);
  if (!result.ok) throw new Error(result.error || `${action} failed`);
  console.log(`${GREEN}${service.name}: ${action} complete${RESET}`);
}

async function deleteService(ref: string): Promise<void> {
  const service = await resolveService(ref);
  const confirmation = await webConfirm("delete_service", "service", service.id);
  if (!confirmation) return;
  const { op_id } = await del<{ op_id: number }>(
    `/api/services/${service.id}`,
    undefined,
    { "X-OCD-Confirmation": confirmation },
  );
  console.log(`Destroying ${BOLD}${service.name}${RESET}…`);
  const result = await followOp(op_id);
  if (!result.ok) throw new Error(result.error || "Service destroy failed");
  console.log(`${GREEN}Service destroyed; its environment is retained.${RESET}`);
}

function numericFlag(args: string[], name: string): number | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  const raw = inline?.slice(name.length + 1) ??
    (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (raw == null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function serviceLogs(ref: string, args: string[]): Promise<void> {
  const service = await resolveService(ref);
  const instance = numericFlag(args, "--instance");
  const tail = numericFlag(args, "--tail") ?? 100;
  const query = new URLSearchParams({ tail: String(tail) });
  if (instance != null) query.set("instance_id", String(instance));
  const result = await get<{ logs: string }>(
    `/api/services/${service.id}/logs?${query.toString()}`,
  );
  process.stdout.write(result.logs.endsWith("\n") ? result.logs : `${result.logs}\n`);
}

async function injectService(
  serviceRef: string,
  environmentRef: string,
  prefix: string,
): Promise<void> {
  const service = await resolveService(serviceRef);
  const environment = await resolveEnvironment(environmentRef);
  const result = await post<{ ok: boolean; stale_apps?: number }>(
    `/api/services/${service.id}/inject/${environment.id}`,
    { env_prefix: prefix },
  );
  console.log(
    `${GREEN}Injected ${service.name} credentials into ${environment.name} with prefix ${prefix}.${RESET}`,
  );
  if (result.stale_apps) {
    console.log(`${DIM}${result.stale_apps} linked app(s) are stale until redeployed or restarted.${RESET}`);
  }
}

async function uninjectService(serviceRef: string, environmentRef: string): Promise<void> {
  const service = await resolveService(serviceRef);
  const environment = await resolveEnvironment(environmentRef);
  const result = await del<{ ok: boolean; stale_apps?: number }>(
    `/api/services/${service.id}/inject/${environment.id}`,
  );
  console.log(`${GREEN}Removed ${service.name} credentials from ${environment.name}.${RESET}`);
  if (result.stale_apps) {
    console.log(`${DIM}${result.stale_apps} linked app(s) are stale until redeployed or restarted.${RESET}`);
  }
}

/** Resolve the terminal target used by `ocd ssh` integration without exposing
 * service credentials. A caller can select an instance explicitly or defaults
 * to the primary/first instance. */
export async function resolveServiceTerminalTarget(
  serviceRef: string,
  instanceId?: number,
): Promise<{ target: string; label: string }> {
  const service = await getServiceDetail(serviceRef);
  const instance = instanceId != null
    ? service.instances?.find((entry) => entry.id === instanceId)
    : service.instances?.[0];
  if (!instance) throw new Error(`No matching instance for ${service.name}`);
  return {
    target: `service-instance:${instance.id}`,
    label: `${service.name} (${instance.container_name})`,
  };
}

function usage(): void {
  console.error(`${BOLD}Usage:${RESET} ocd service <command>

${BOLD}Commands:${RESET}
  list                               List managed services
  catalog                            List supported service types and versions
  create <name> --type=<type> ...    Deploy a standalone managed service
  show <service> [--show-secrets]    Show service, instances, connection and links
  restart|pause|unpause <service>    Run a lifecycle operation and follow it
  logs <service> [--tail=N] [--instance=ID]
  inject <service> <env> [--prefix=DATABASE]
  uninject <service> <env>           Remove injected credentials
  delete <service>                   Confirm in the web UI, then destroy containers

Use ${BOLD}ocd ssh <service> --service${RESET} for a service container terminal.`);
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
  if (args[0] === "show" || args[0] === "status") {
    if (!args[1]) throw new Error("Usage: ocd service show <service> [--show-secrets]");
    await showService(args[1], args.includes("--show-secrets"));
    return;
  }
  if (["restart", "pause", "unpause"].includes(args[0])) {
    if (!args[1]) throw new Error(`Usage: ocd service ${args[0]} <service>`);
    await runServiceOp(args[1], args[0] as "restart" | "pause" | "unpause");
    return;
  }
  if (args[0] === "logs") {
    if (!args[1]) throw new Error("Usage: ocd service logs <service> [--tail=N] [--instance=ID]");
    await serviceLogs(args[1], args.slice(2));
    return;
  }
  if (args[0] === "inject" || args[0] === "link") {
    if (!args[1] || !args[2]) {
      throw new Error("Usage: ocd service inject <service> <environment> [--prefix=DATABASE]");
    }
    const prefix = args.find((arg) => arg.startsWith("--prefix="))?.slice(9) || "DATABASE";
    await injectService(args[1], args[2], prefix);
    return;
  }
  if (args[0] === "uninject" || args[0] === "unlink") {
    if (!args[1] || !args[2]) {
      throw new Error("Usage: ocd service uninject <service> <environment>");
    }
    await uninjectService(args[1], args[2]);
    return;
  }
  if (args[0] === "delete" || args[0] === "destroy" || args[0] === "remove") {
    if (args.includes("--yes") || args.includes("-y")) {
      throw new Error("--yes has been removed; approve service deletion in the web UI");
    }
    if (!args[1]) throw new Error("Usage: ocd service delete <service>");
    await deleteService(args[1]);
    return;
  }
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    usage();
    return;
  }
  if (args.length > 0 && !["list", "ls"].includes(args[0])) {
    console.error(`${RED}Unknown service command: ${args[0]}${RESET}`);
    usage();
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
