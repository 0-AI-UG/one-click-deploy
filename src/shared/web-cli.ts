export type WebCliResource =
  | "app"
  | "environment"
  | "deleted-environment"
  | "service"
  | "stack"
  | "server"
  | "volume";

export type WebCliInput = {
  key: string;
  label: string;
  description?: string;
  kind: "text" | "number" | "boolean" | "select" | "resource" | "key-value";
  resource?: WebCliResource;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  repeatable?: boolean;
  positional?: boolean;
  flag?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  defaultValue?: string | boolean;
};

export type WebCliCommand = {
  id: string;
  category: string;
  label: string;
  description: string;
  args: string[];
  inputs: WebCliInput[];
  danger?: boolean;
  fixedArgs?: string[];
  unavailableReason?: string;
};

const app = (description = "App name or numeric ID"): WebCliInput => ({
  key: "app", label: "App", description, kind: "resource", resource: "app", required: true, positional: true,
});
const service = (): WebCliInput => ({
  key: "service", label: "Service", kind: "resource", resource: "service", required: true, positional: true,
});
const environment = (key = "environment", label = "Environment"): WebCliInput => ({
  key, label, kind: "resource", resource: "environment", required: true, positional: true,
});
const stack = (): WebCliInput => ({
  key: "stack", label: "Stack", kind: "resource", resource: "stack", required: true, positional: true,
});
const server = (): WebCliInput => ({
  key: "server", label: "Server", kind: "resource", resource: "server", required: true, positional: true,
});
const positiveNumber = (key: string, label: string, opts: Partial<WebCliInput> = {}): WebCliInput => ({
  key, label, kind: "number", min: 1, ...opts,
});

/**
 * The web command builder and the server-side executor deliberately share this
 * catalog. A browser submits a command id plus typed values; it never submits
 * argv or shell text.
 */
export const WEB_CLI_COMMANDS: WebCliCommand[] = [
  { id: "status", category: "Overview", label: "Status", description: "Show the dashboard overview.", args: ["status"], inputs: [] },
  { id: "apps.list", category: "Overview", label: "List apps", description: "List all visible apps.", args: ["apps"], inputs: [] },

  { id: "app.show", category: "Apps", label: "App details", description: "Show manifest configuration and runtime state.", args: ["app", "show"], inputs: [app()] },
  { id: "app.deployments", category: "Apps", label: "Deployment history", description: "List deployments for an app.", args: ["app", "deployments"], inputs: [app()] },
  { id: "app.replicas", category: "Apps", label: "Replicas", description: "List replicas and current resource use.", args: ["app", "replicas"], inputs: [app()] },
  { id: "app.metrics", category: "Apps", label: "Metrics", description: "Show current or historical app metrics.", args: ["app", "metrics"], inputs: [app(), positiveNumber("since", "History window (seconds)", { flag: "since", placeholder: "3600" })] },
  { id: "app.availability", category: "Apps", label: "Availability", description: "Show trailing availability and placement.", args: ["app", "availability"], inputs: [app(), positiveNumber("window", "Window (seconds)", { flag: "window", defaultValue: "86400" })] },
  { id: "app.scaling-events", category: "Apps", label: "Scaling events", description: "List recent manual and autoscaling events.", args: ["app", "scaling-events"], inputs: [app()] },
  { id: "app.staging", category: "Apps", label: "Staging state", description: "Inspect an app's webhook-staging sibling.", args: ["app", "staging"], inputs: [app()] },
  { id: "app.webhook", category: "Apps", label: "Webhook status", description: "Inspect stored webhook configuration.", args: ["app", "webhook", "status"], inputs: [app()] },
  { id: "app.logs", category: "Apps", label: "App logs", description: "Read recent container logs.", args: ["logs"], inputs: [app(), positiveNumber("tail", "Lines", { flag: "tail", defaultValue: "100", max: 10000 }), positiveNumber("replica", "Replica ID", { flag: "replica" })] },
  { id: "app.restart", category: "Apps", label: "Restart", description: "Restart all replicas and follow the operation.", args: ["restart"], inputs: [app()] },
  { id: "app.pause", category: "Apps", label: "Pause", description: "Pause an app and follow the operation.", args: ["pause"], inputs: [app()] },
  { id: "app.unpause", category: "Apps", label: "Unpause", description: "Resume a paused app and follow the operation.", args: ["unpause"], inputs: [app()] },
  { id: "app.rollback", category: "Apps", label: "Rollback", description: "Roll back to a selected or previous successful deployment.", args: ["rollback"], inputs: [app(), positiveNumber("deployment", "Deployment ID", { flag: "deployment" })] },
  { id: "app.reload-env", category: "Apps", label: "Reload environment", description: "Recreate the app from its immutable image with current environment values.", args: ["app", "reload-env"], inputs: [app()], danger: true, fixedArgs: ["--force"] },
  { id: "app.promote", category: "Apps", label: "Promote staging", description: "Promote the exact deployed source version to another app.", args: ["promote"], inputs: [{ ...app("Source app"), key: "from", label: "From", positional: false, flag: "from" }, { ...app("Destination app"), key: "to", label: "To", positional: false, flag: "to" }], danger: true, fixedArgs: ["--yes"] },
  { id: "app.delete", category: "Apps", label: "Delete app", description: "Destroy app containers and DNS; managed volumes are detached and retained.", args: ["delete"], inputs: [app()], danger: true, fixedArgs: ["--yes"] },
  { id: "app.deploy", category: "Apps", label: "Deploy manifest", description: "Apply a repository manifest and deploy its current Git commit.", args: ["deploy"], inputs: [], unavailableReason: "Deploy reads the local repository manifest, origin, and commit. Run it from the app repository so the panel never guesses or substitutes server-stored state." },

  { id: "scale.wake", category: "Scaling", label: "Wake app", description: "Wake a scaled-to-zero app.", args: ["scale", "wake"], inputs: [app()] },
  { id: "scale.policy", category: "Scaling", label: "Show scaling policy", description: "Show the manifest-applied scaling policy.", args: ["scale", "policy", "show"], inputs: [app()] },
  { id: "scale.migrate", category: "Scaling", label: "Migrate replica", description: "Move a replica to another server.", args: ["scale", "migrate"], inputs: [app(), positiveNumber("replica", "Replica ID", { required: true, positional: true }), { ...server(), key: "target", label: "Target server", positional: false, flag: "to" }] },

  { id: "stacks.list", category: "Stacks", label: "List stacks", description: "List all stacks.", args: ["stack", "ls"], inputs: [] },
  { id: "stacks.status", category: "Stacks", label: "Stack status", description: "Show a stack's apps and services.", args: ["stack", "status"], inputs: [stack()] },
  { id: "stacks.logs", category: "Stacks", label: "Stack deploy log", description: "Print the stack's deploy log.", args: ["stack", "logs"], inputs: [stack()] },
  { id: "stacks.member-logs", category: "Stacks", label: "Member logs", description: "Print current logs for every readable member.", args: ["stack", "member-logs"], inputs: [stack(), positiveNumber("tail", "Lines per member", { flag: "tail", defaultValue: "100", max: 10000 })] },
  { id: "stacks.promote", category: "Stacks", label: "Promote stack", description: "Promote ready staging siblings in dependency order.", args: ["promote", "stack"], inputs: [stack()], danger: true, fixedArgs: ["--yes"] },
  { id: "stacks.deploy", category: "Stacks", label: "Deploy stack", description: "Deploy a stack from repository manifests.", args: ["deploy", "stack"], inputs: [], unavailableReason: "Stack deployment reads multiple manifests and the current Git repository. Run it from that repository." },
  { id: "stacks.delete", category: "Stacks", label: "Delete stack", description: "Destroy a stack and all members.", args: ["delete", "stack"], inputs: [stack()], unavailableReason: "Stack deletion always requires the dedicated browser approval flow. Use the local CLI and approve the generated request in the panel." },

  { id: "envs.list", category: "Environments", label: "List environments", description: "List active environments.", args: ["envs", "list"], inputs: [] },
  { id: "envs.show", category: "Environments", label: "Environment details", description: "Show variables, links, and rollout state.", args: ["envs", "show"], inputs: [environment()] },
  { id: "envs.create", category: "Environments", label: "Create environment", description: "Create an environment with optional plain values.", args: ["envs", "create"], inputs: [{ key: "name", label: "Name", kind: "text", required: true, positional: true }, { key: "vars", label: "Variables", description: "One KEY=VALUE per line. Secret entry remains local-CLI only so values never appear in process arguments.", kind: "key-value", repeatable: true, positional: true, placeholder: "NODE_ENV=production" }] },
  { id: "envs.copy", category: "Environments", label: "Copy environment", description: "Duplicate an environment, including secrets.", args: ["envs", "copy"], inputs: [environment(), { key: "newName", label: "New name", kind: "text", required: true, positional: true }] },
  { id: "envs.rename", category: "Environments", label: "Rename environment", description: "Rename without changing variables.", args: ["envs", "rename"], inputs: [environment(), { key: "newName", label: "New name", kind: "text", required: true, positional: true }] },
  { id: "envs.set", category: "Environments", label: "Set variables", description: "Merge plain variables and optionally control rollout.", args: ["envs", "set"], inputs: [environment(), { key: "vars", label: "Variables", kind: "key-value", required: true, repeatable: true, positional: true, placeholder: "FEATURE_FLAG=true" }, { key: "replace", label: "Replace all existing variables", kind: "boolean", flag: "replace" }, { key: "rollout", label: "Rollout", kind: "select", flag: "rollout", defaultValue: "redeploy", options: [{ value: "redeploy", label: "Redeploy" }, { value: "restart", label: "Restart without build" }, { value: "none", label: "Do not roll out" }] }] },
  { id: "envs.unset", category: "Environments", label: "Unset variables", description: "Remove one or more variables.", args: ["envs", "unset"], inputs: [environment(), { key: "keys", label: "Variable keys", description: "One key per line.", kind: "text", required: true, repeatable: true, positional: true }] },
  { id: "envs.deleted", category: "Environments", label: "Deleted environments", description: "List recoverable retired environments.", args: ["envs", "deleted"], inputs: [] },
  { id: "envs.restore", category: "Environments", label: "Restore environment", description: "Restore a retired environment.", args: ["envs", "restore"], inputs: [{ ...environment(), resource: "deleted-environment" }] },
  { id: "envs.delete", category: "Environments", label: "Retire environment", description: "Retire an environment for recovery.", args: ["envs", "remove"], inputs: [environment()], unavailableReason: "Environment retirement always requires the dedicated browser approval flow. Use the local CLI and approve it here." },
  { id: "envs.purge", category: "Environments", label: "Purge environment", description: "Permanently erase a retired environment.", args: ["envs", "purge"], inputs: [], unavailableReason: "Permanent environment deletion always requires the dedicated browser approval flow." },

  { id: "services.list", category: "Services", label: "List services", description: "List managed services.", args: ["service", "list"], inputs: [] },
  { id: "services.catalog", category: "Services", label: "Service catalog", description: "Show supported service types and defaults.", args: ["service", "catalog"], inputs: [] },
  { id: "services.show", category: "Services", label: "Service details", description: "Show instances, connection details, and links (secrets remain masked).", args: ["service", "show"], inputs: [service()] },
  { id: "services.logs", category: "Services", label: "Service logs", description: "Read recent service logs.", args: ["service", "logs"], inputs: [service(), positiveNumber("tail", "Lines", { flag: "tail", defaultValue: "100", max: 10000 }), positiveNumber("instance", "Instance ID", { flag: "instance" })] },
  { id: "services.restart", category: "Services", label: "Restart service", description: "Restart a service and follow the operation.", args: ["service", "restart"], inputs: [service()] },
  { id: "services.pause", category: "Services", label: "Pause service", description: "Pause a managed service.", args: ["service", "pause"], inputs: [service()] },
  { id: "services.unpause", category: "Services", label: "Unpause service", description: "Resume a managed service.", args: ["service", "unpause"], inputs: [service()] },
  { id: "services.inject", category: "Services", label: "Inject credentials", description: "Inject service credentials into an environment.", args: ["service", "inject"], inputs: [service(), environment(), { key: "prefix", label: "Prefix", kind: "text", flag: "prefix", defaultValue: "DATABASE" }] },
  { id: "services.uninject", category: "Services", label: "Remove credentials", description: "Remove injected service credentials from an environment.", args: ["service", "uninject"], inputs: [service(), environment()] },
  { id: "services.delete", category: "Services", label: "Delete service", description: "Destroy service containers and retain its environment.", args: ["service", "delete"], inputs: [service()], danger: true, fixedArgs: ["--yes"] },
  { id: "services.create", category: "Services", label: "Create service", description: "Provision a standalone managed service.", args: ["service", "create"], inputs: [{ key: "name", label: "Name", kind: "text", required: true, positional: true }, { key: "type", label: "Catalog type", kind: "text", required: true, flag: "type", placeholder: "postgresql" }, { key: "version", label: "Version", kind: "text", flag: "version" }, positiveNumber("volumeSize", "Volume size (GB)", { flag: "volume-size" }), { ...environment(), required: false, positional: false, flag: "env" }, { key: "envPrefix", label: "Environment prefix", kind: "text", flag: "env-prefix" }, { key: "domain", label: "Domain", kind: "text", flag: "domain" }] },

  { id: "ops.list", category: "Operations", label: "List operations", description: "List engine operations.", args: ["ops", "list"], inputs: [{ ...app(), required: false, positional: false, flag: "app" }, positiveNumber("limit", "Limit", { flag: "limit", defaultValue: "20", max: 200 })] },
  { id: "ops.engine", category: "Operations", label: "Engine status", description: "Show heartbeat, concurrency, and operation kinds.", args: ["ops", "engine"], inputs: [] },
  { id: "ops.show", category: "Operations", label: "Operation details", description: "Show steps and child operations.", args: ["ops"], inputs: [positiveNumber("operation", "Operation ID", { required: true, positional: true })] },
  { id: "ops.logs", category: "Operations", label: "Operation logs", description: "Print available logs or follow the operation live.", args: ["ops", "logs"], inputs: [positiveNumber("operation", "Operation ID", { required: true, positional: true }), positiveNumber("since", "After log ID", { flag: "since", min: 0 }), { key: "follow", label: "Follow until complete", kind: "boolean", flag: "follow" }] },
  { id: "ops.retry", category: "Operations", label: "Retry operation", description: "Resume cleanup or create a fresh retry.", args: ["ops", "retry"], inputs: [positiveNumber("operation", "Operation ID", { required: true, positional: true })], danger: true },
  { id: "ops.finalize", category: "Operations", label: "Finalize operation", description: "Reconcile resources and close a stale operation.", args: ["ops", "finalize"], inputs: [positiveNumber("operation", "Operation ID", { required: true, positional: true }), { key: "status", label: "Final status", kind: "select", flag: "status", defaultValue: "auto", options: [{ value: "auto", label: "Automatic assessment" }, { value: "done", label: "Done" }, { value: "failed", label: "Failed" }] }], danger: true },
  { id: "ops.cancel", category: "Operations", label: "Cancel operation", description: "Stop and compensate an operation safely.", args: ["ops", "cancel"], inputs: [positiveNumber("operation", "Operation ID", { required: true, positional: true })], danger: true, fixedArgs: ["--yes"] },

  { id: "servers.list", category: "Servers", label: "List servers", description: "List servers and placement pools.", args: ["servers", "ls"], inputs: [] },
  { id: "servers.show", category: "Servers", label: "Server details", description: "Show workloads and host diagnostics.", args: ["servers", "show"], inputs: [server()] },
  { id: "servers.diagnose", category: "Servers", label: "Server diagnostics", description: "Show host-level diagnostics.", args: ["servers", "diagnose"], inputs: [server()] },
  { id: "servers.metrics", category: "Servers", label: "Server metrics", description: "Show server metric history.", args: ["servers", "metrics"], inputs: [{ ...server(), required: false }, positiveNumber("since", "History window (seconds)", { flag: "since", defaultValue: "3600" })] },
  { id: "servers.refresh", category: "Servers", label: "Refresh inventory", description: "Refresh provider-backed server inventory.", args: ["servers", "refresh"], inputs: [] },
  { id: "servers.pool", category: "Servers", label: "Change pool", description: "Change a server's future-placement pool.", args: ["servers", "pool"], inputs: [server(), { key: "pool", label: "Pool", kind: "text", required: true, positional: true, placeholder: "general" }] },
  { id: "servers.create", category: "Servers", label: "Provision server", description: "Provision a provider server.", args: ["servers", "create"], inputs: [{ key: "type", label: "Server type", kind: "text", required: true, flag: "type" }, { key: "location", label: "Location", kind: "text", required: true, flag: "location" }, { key: "name", label: "Name", kind: "text", flag: "name" }], danger: true },
  { id: "servers.delete", category: "Servers", label: "Delete server", description: "Permanently destroy an unused server.", args: ["servers", "delete"], inputs: [server()], danger: true, fixedArgs: ["--yes"] },

  { id: "resources.list", category: "Resources", label: "Resource inventory", description: "Show servers, volumes, retention, and estimated cost.", args: ["resources", "ls"], inputs: [] },
  { id: "volumes.list", category: "Resources", label: "List volumes", description: "List provider volumes and retention state.", args: ["volumes", "list"], inputs: [] },
  { id: "volumes.show", category: "Resources", label: "Volume details", description: "Show volume ownership, mount, and cost.", args: ["volumes", "show"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }] },
  { id: "volumes.audit", category: "Resources", label: "Volume deletion audit", description: "Show the durable deletion audit.", args: ["volumes", "audit"], inputs: [] },
  { id: "volumes.files", category: "Resources", label: "Browse volume", description: "List files in an attached volume.", args: ["volumes", "ls"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }, { key: "path", label: "Path", kind: "text", positional: true, placeholder: "subdirectory" }] },
  { id: "volumes.cat", category: "Resources", label: "Read volume file", description: "Read a text file (up to the CLI/API limit).", args: ["volumes", "cat"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }, { key: "path", label: "Path", kind: "text", required: true, positional: true }] },
  { id: "volumes.delete", category: "Resources", label: "Delete volume", description: "Permanently destroy an unused provider volume and its data.", args: ["volumes", "delete"], inputs: [], unavailableReason: "Permanent volume deletion always requires typed browser approval. Use the local CLI and approve it here." },

  { id: "ssh", category: "Local-only", label: "SSH / exec", description: "Open a shell or run a command on a server or container.", args: ["ssh"], inputs: [], unavailableReason: "The friendly web runner is an OCD command allowlist, not a general shell. Use the existing scoped terminal or the local CLI." },
  { id: "skill", category: "Local-only", label: "Install agent skill", description: "Install the OCD skill into a local coding agent.", args: ["skill", "install"], inputs: [], unavailableReason: "Skill installation changes the caller's local filesystem, not the panel server." },
  { id: "login", category: "Local-only", label: "Login", description: "Authenticate a local CLI.", args: ["login"], inputs: [], unavailableReason: "This page already runs as the signed-in panel user; local CLI login belongs on the user's machine." },
];

export type WebCliValues = Record<string, string | boolean | string[] | undefined>;

function clean(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const result = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(result) || result.length > 4096) throw new Error(`${label} is invalid`);
  return result;
}

export function findWebCliCommand(id: string): WebCliCommand | undefined {
  return WEB_CLI_COMMANDS.find((command) => command.id === id);
}

export function formatWebCliCommand(argv: string[]): string {
  return ["ocd", ...argv]
    .map((part) => /^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part))
    .join(" ");
}

export function buildWebCliArgv(command: WebCliCommand, values: WebCliValues): string[] {
  if (command.unavailableReason) throw new Error(command.unavailableReason);
  const known = new Set(command.inputs.map((input) => input.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`Unknown parameter: ${key}`);
  }

  const positional: string[] = [];
  const flags: string[] = [];
  for (const input of command.inputs) {
    const raw = values[input.key];
    if (input.kind === "boolean") {
      if (raw !== undefined && typeof raw !== "boolean") throw new Error(`${input.label} must be true or false`);
      if (raw && input.flag) flags.push(`--${input.flag}`);
      continue;
    }

    const rows = input.repeatable
      ? (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/\r?\n/) : [])
      : [raw];
    if (rows.length > 100) throw new Error(`${input.label} accepts at most 100 values`);
    const cleaned = rows
      .filter((row): row is string => typeof row === "string" && row.trim().length > 0)
      .map((row) => clean(row, input.label));
    if (input.required && cleaned.length === 0) throw new Error(`${input.label} is required`);

    for (const value of cleaned) {
      if (input.kind === "number") {
        const number = Number(value);
        if (!Number.isFinite(number) || !Number.isInteger(number)) throw new Error(`${input.label} must be a whole number`);
        if (input.min !== undefined && number < input.min) throw new Error(`${input.label} must be at least ${input.min}`);
        if (input.max !== undefined && number > input.max) throw new Error(`${input.label} must be at most ${input.max}`);
      }
      if (input.kind === "select" && input.options && !input.options.some((option) => option.value === value)) {
        throw new Error(`${input.label} has an invalid value`);
      }
      if (input.kind === "key-value" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        throw new Error(`${input.label} entries must use KEY=VALUE`);
      }
      if (input.positional) {
        if (value.startsWith("-")) throw new Error(`${input.label} cannot start with a dash`);
        positional.push(value);
      }
      else if (input.flag) flags.push(`--${input.flag}=${value}`);
    }
  }
  const argv = [...command.args, ...positional, ...flags, ...(command.fixedArgs || [])];
  if (argv.reduce((total, value) => total + value.length, 0) > 64 * 1024) {
    throw new Error("Command parameters are too large");
  }
  return argv;
}
