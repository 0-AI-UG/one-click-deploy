export type WebCliResource =
  | "app"
  | "environment"
  | "deleted-environment"
  | "stack"
  | "server"
  | "volume"
  | "operation"
  | "deployment"
  | "replica"
  | "server-type"
  | "location";

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
  /** Values sent to CLI stdin instead of argv. Used for secrets. */
  transport?: "secret-vars" | "stdin" | "set-vars" | "staging-set-vars";
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
const resource = (
  key: string,
  label: string,
  kind: WebCliResource,
  opts: Partial<WebCliInput> = {},
): WebCliInput => ({ key, label, kind: "resource", resource: kind, ...opts });

/**
 * The web command builder and the server-side executor deliberately share this
 * catalog. A browser submits a command id plus typed values; it never submits
 * argv or shell text.
 */
export const WEB_CLI_COMMANDS: WebCliCommand[] = [
  { id: "status", category: "Overview", label: "Status", description: "Show the dashboard overview.", args: ["status"], inputs: [] },
  { id: "apps.list", category: "Overview", label: "List apps", description: "List all visible apps.", args: ["apps"], inputs: [] },
  { id: "doctor", category: "Overview", label: "Deploy readiness", description: "Check capacity and build connections without changing them.", args: ["doctor"], inputs: [] },

  { id: "app.show", category: "Apps", label: "App details", description: "Show manifest configuration and runtime state.", args: ["app", "show"], inputs: [app()] },
  { id: "app.storage", category: "Apps", label: "Image storage", description: "Show current, rollback, and reclaimable image storage.", args: ["app", "show"], inputs: [app()], fixedArgs: ["--storage"] },
  { id: "app.deployments", category: "Apps", label: "Deployment history", description: "List deployments for an app.", args: ["app", "deployments"], inputs: [app()] },
  { id: "app.replicas", category: "Apps", label: "Replicas", description: "List replicas and current resource use.", args: ["app", "replicas"], inputs: [app()] },
  { id: "app.metrics", category: "Apps", label: "Metrics", description: "Show current or historical app metrics.", args: ["app", "metrics"], inputs: [app(), positiveNumber("since", "History window (seconds)", { flag: "since", placeholder: "3600" })] },
  { id: "app.availability", category: "Apps", label: "Availability", description: "Show trailing availability and placement.", args: ["app", "availability"], inputs: [app(), positiveNumber("window", "Window (seconds)", { flag: "window", defaultValue: "86400" })] },
  { id: "app.scaling-events", category: "Apps", label: "Scaling events", description: "List recent manual and autoscaling events.", args: ["app", "scaling-events"], inputs: [app()] },
  { id: "app.staging", category: "Apps", label: "Staging state", description: "Inspect an app's explicit staging sibling.", args: ["app", "staging"], inputs: [app()] },
  { id: "app.logs", category: "Apps", label: "App logs", description: "Read recent container logs.", args: ["logs"], inputs: [app(), positiveNumber("tail", "Lines", { flag: "tail", defaultValue: "100", max: 10000 }), resource("replica", "Replica", "replica", { flag: "replica" })] },
  { id: "app.restart", category: "Apps", label: "Restart", description: "Restart all replicas and follow the operation.", args: ["restart"], inputs: [app()] },
  { id: "app.pause", category: "Apps", label: "Pause", description: "Pause an app and follow the operation.", args: ["pause"], inputs: [app()] },
  { id: "app.unpause", category: "Apps", label: "Unpause", description: "Resume a paused app and follow the operation.", args: ["unpause"], inputs: [app()] },
  { id: "app.rollback", category: "Apps", label: "Rollback", description: "Roll back to a selected or previous successful deployment.", args: ["rollback"], inputs: [app(), resource("deployment", "Deployment", "deployment", { flag: "deployment" })] },
  { id: "app.redeploy", category: "Apps", label: "Redeploy current image", description: "Recreate the app using its stored immutable image and configuration.", args: ["app", "redeploy"], inputs: [app()] },
  { id: "app.reload-env", category: "Apps", label: "Reload environment", description: "Recreate the app from its immutable image with current environment values.", args: ["app", "reload-env"], inputs: [app()], danger: true, fixedArgs: ["--force"] },
  { id: "app.promote", category: "Apps", label: "Promote staging", description: "Promote the exact deployed source version to another app.", args: ["promote"], inputs: [{ ...app("Source app"), key: "from", label: "From", positional: false, flag: "from" }, { ...app("Destination app"), key: "to", label: "To", positional: false, flag: "to" }], danger: true },
  { id: "app.delete", category: "Apps", label: "Delete app", description: "Destroy app containers; DNS stays operator-owned and managed volumes are detached and retained.", args: ["delete"], inputs: [app()], danger: true },
  { id: "app.release", category: "Apps", label: "Deploy existing artifact", description: "Release an externally built immutable image digest while retaining configuration.", args: ["release"], inputs: [app(), { key: "image", label: "Immutable image", kind: "text", required: true, flag: "image" }, { key: "commit", label: "Source commit", kind: "text", flag: "commit" }] },
  { id: "app.deploy", category: "Apps", label: "Build and deploy manifest", description: "Build the exact Git commit on an OCD worker and apply complete desired state.", args: ["deploy"], inputs: [{ key: "manifest", label: "Manifest path", kind: "text", required: true, positional: true }, { key: "commit", label: "Git commit", kind: "text", required: true, flag: "commit" }, { key: "appName", label: "App name override", kind: "text", flag: "app" }, { key: "vars", label: "Environment overrides", kind: "key-value", repeatable: true, transport: "set-vars" }, { key: "dryRun", label: "Preview only", kind: "boolean", flag: "dry-run" }, { key: "configOnly", label: "Configuration only", kind: "boolean", flag: "config-only" }, { key: "allowUnknown", label: "Allow unknown manifest keys", kind: "boolean", flag: "allow-unknown" }] },

  { id: "scale.wake", category: "Scaling", label: "Wake app", description: "Wake a scaled-to-zero app.", args: ["scale", "wake"], inputs: [app()] },
  { id: "scale.policy", category: "Scaling", label: "Show scaling policy", description: "Show the manifest-applied scaling policy.", args: ["scale", "policy", "show"], inputs: [app()] },
  { id: "scale.migrate", category: "Scaling", label: "Migrate replica", description: "Move a replica to another server.", args: ["scale", "migrate"], inputs: [app(), resource("replica", "Replica", "replica", { required: true, positional: true }), { ...server(), key: "target", label: "Target server", positional: false, flag: "to" }] },

  { id: "stacks.list", category: "Stacks", label: "List stacks", description: "List all stacks.", args: ["stack", "ls"], inputs: [] },
  { id: "stacks.status", category: "Stacks", label: "Stack status", description: "Show a stack's apps.", args: ["stack", "status"], inputs: [stack()] },
  { id: "stacks.logs", category: "Stacks", label: "Stack deploy log", description: "Print the stack's deploy log.", args: ["stack", "logs"], inputs: [stack()] },
  { id: "stacks.member-logs", category: "Stacks", label: "Member logs", description: "Print current logs for every readable member.", args: ["stack", "member-logs"], inputs: [stack(), positiveNumber("tail", "Lines per member", { flag: "tail", defaultValue: "100", max: 10000 })] },
  { id: "stacks.promote", category: "Stacks", label: "Promote stack", description: "Promote ready staging siblings in dependency order.", args: ["promote", "stack"], inputs: [stack()], danger: true },
  { id: "stacks.deploy", category: "Stacks", label: "Deploy stack", description: "Deploy a stack from digest-pinned manifests.", args: ["deploy", "stack"], inputs: [{ key: "manifest", label: "Stack manifest path", kind: "text", required: true, positional: true }, { key: "commit", label: "Git commit", kind: "text", required: true, flag: "commit" }, { key: "vars", label: "Environment overrides", kind: "key-value", repeatable: true, transport: "set-vars" }, { key: "stagingVars", label: "Staging overrides", kind: "key-value", repeatable: true, transport: "staging-set-vars" }, { key: "only", label: "Members", kind: "text", flag: "only" }, { key: "withDependents", label: "Include dependents", kind: "boolean", flag: "with-dependents" }, { key: "changed", label: "Changed members only", kind: "boolean", flag: "changed" }, { key: "all", label: "All members", kind: "boolean", flag: "all" }, { key: "configOnly", label: "Configuration only", kind: "boolean", flag: "config-only" }, { key: "allowUnknown", label: "Allow unknown manifest keys", kind: "boolean", flag: "allow-unknown" }] },
  { id: "stacks.delete", category: "Stacks", label: "Delete stack", description: "Destroy a stack and all members.", args: ["delete", "stack"], inputs: [stack()], danger: true },

  { id: "envs.list", category: "Environments", label: "List environments", description: "List active environments.", args: ["envs", "list"], inputs: [] },
  { id: "envs.show", category: "Environments", label: "Environment details", description: "Show variables, links, and rollout state.", args: ["envs", "show"], inputs: [environment()] },
  { id: "envs.create", category: "Environments", label: "Create environment", description: "Create an environment with plain and encrypted values.", args: ["envs", "create"], inputs: [{ key: "name", label: "Name", kind: "text", required: true, positional: true }, { key: "vars", label: "Variables", kind: "key-value", repeatable: true, positional: true, placeholder: "NODE_ENV=production" }, { key: "secretVars", label: "Secret variables", description: "Encrypted values are transported through stdin and never process arguments.", kind: "key-value", repeatable: true, transport: "secret-vars" }] },
  { id: "envs.copy", category: "Environments", label: "Copy environment", description: "Duplicate an environment, including secrets.", args: ["envs", "copy"], inputs: [environment(), { key: "newName", label: "New name", kind: "text", required: true, positional: true }] },
  { id: "envs.rename", category: "Environments", label: "Rename environment", description: "Rename without changing variables.", args: ["envs", "rename"], inputs: [environment(), { key: "newName", label: "New name", kind: "text", required: true, positional: true }] },
  { id: "envs.set", category: "Environments", label: "Set variables", description: "Merge plain and encrypted variables and optionally control rollout.", args: ["envs", "set"], inputs: [environment(), { key: "vars", label: "Variables", kind: "key-value", repeatable: true, positional: true, placeholder: "FEATURE_FLAG=true" }, { key: "secretVars", label: "Secret variables", kind: "key-value", repeatable: true, transport: "secret-vars" }, { key: "replace", label: "Replace all existing variables", kind: "boolean", flag: "replace" }, { key: "rollout", label: "Rollout", kind: "select", flag: "rollout", defaultValue: "redeploy", options: [{ value: "redeploy", label: "Redeploy" }, { value: "restart", label: "Restart without build" }, { value: "none", label: "Do not roll out" }] }] },
  { id: "envs.unset", category: "Environments", label: "Unset variables", description: "Remove one or more variables.", args: ["envs", "unset"], inputs: [environment(), { key: "keys", label: "Variable keys", description: "One key per line.", kind: "text", required: true, repeatable: true, positional: true }, { key: "rollout", label: "Rollout", kind: "select", flag: "rollout", defaultValue: "redeploy", options: [{ value: "redeploy", label: "Redeploy" }, { value: "restart", label: "Restart without build" }, { value: "none", label: "Do not roll out" }] }] },
  { id: "envs.deleted", category: "Environments", label: "Deleted environments", description: "List recoverable retired environments.", args: ["envs", "deleted"], inputs: [] },
  { id: "envs.restore", category: "Environments", label: "Restore environment", description: "Restore a retired environment.", args: ["envs", "restore"], inputs: [{ ...environment(), resource: "deleted-environment" }] },
  { id: "envs.delete", category: "Environments", label: "Retire environment", description: "Retire an environment for recovery.", args: ["envs", "remove"], inputs: [environment(), { key: "copyName", label: "Recovery copy name", kind: "text", flag: "copy-before-delete" }], danger: true },
  { id: "envs.purge", category: "Environments", label: "Purge environment", description: "Permanently erase a retired environment.", args: ["envs", "purge"], inputs: [{ ...environment(), resource: "deleted-environment" }], danger: true },

  { id: "ops.list", category: "Operations", label: "List operations", description: "List engine operations.", args: ["ops", "list"], inputs: [{ ...app(), required: false, positional: false, flag: "app" }, positiveNumber("limit", "Limit", { flag: "limit", defaultValue: "20", max: 200 })] },
  { id: "ops.engine", category: "Operations", label: "Engine status", description: "Show heartbeat, concurrency, and operation kinds.", args: ["ops", "engine"], inputs: [] },
  { id: "ops.show", category: "Operations", label: "Operation details", description: "Show steps and child operations.", args: ["ops"], inputs: [resource("operation", "Operation", "operation", { required: true, positional: true })] },
  { id: "ops.logs", category: "Operations", label: "Operation logs", description: "Print available logs or follow the operation live.", args: ["ops", "logs"], inputs: [resource("operation", "Operation", "operation", { required: true, positional: true }), positiveNumber("tail", "Tail", { flag: "tail", min: 0, max: 10000 }), { key: "since", label: "Since", kind: "text", flag: "since" }, { key: "child", label: "Child", kind: "text", flag: "child" }, { key: "phase", label: "Phase", kind: "text", flag: "phase" }, { key: "follow", label: "Follow until complete", kind: "boolean", flag: "follow" }] },
  { id: "ops.retry", category: "Operations", label: "Retry operation", description: "Resume cleanup or create a fresh retry.", args: ["ops", "retry"], inputs: [resource("operation", "Operation", "operation", { required: true, positional: true })], danger: true },
  { id: "ops.finalize", category: "Operations", label: "Finalize operation", description: "Reconcile resources and close a stale operation.", args: ["ops", "finalize"], inputs: [resource("operation", "Operation", "operation", { required: true, positional: true }), { key: "status", label: "Final status", kind: "select", flag: "status", defaultValue: "auto", options: [{ value: "auto", label: "Automatic assessment" }, { value: "done", label: "Done" }, { value: "failed", label: "Failed" }] }], danger: true },
  { id: "ops.cancel", category: "Operations", label: "Cancel operation", description: "Stop and compensate an operation safely.", args: ["ops", "cancel"], inputs: [resource("operation", "Operation", "operation", { required: true, positional: true })], danger: true },

  { id: "servers.list", category: "Servers", label: "List servers", description: "List servers and placement pools.", args: ["servers", "ls"], inputs: [] },
  { id: "servers.show", category: "Servers", label: "Server details", description: "Show workloads and host diagnostics.", args: ["servers", "show"], inputs: [server()] },
  { id: "servers.diagnose", category: "Servers", label: "Server diagnostics", description: "Show host-level diagnostics.", args: ["servers", "diagnose"], inputs: [server()] },
  { id: "servers.metrics", category: "Servers", label: "Server metrics", description: "Show server metric history.", args: ["servers", "metrics"], inputs: [{ ...server(), required: false }, positiveNumber("since", "History window (seconds)", { flag: "since", defaultValue: "3600" })] },
  { id: "servers.refresh", category: "Servers", label: "Refresh inventory", description: "Refresh provider-backed server inventory.", args: ["servers", "refresh"], inputs: [] },
  { id: "servers.enrollment-key", category: "Servers", label: "Enrollment key", description: "Show the panel public key for connecting an external server.", args: ["servers", "enrollment-key"], inputs: [] },
  { id: "servers.connect", category: "Servers", label: "Connect server", description: "Connect an externally owned stateless host.", args: ["servers", "connect"], inputs: [{ key: "name", label: "Name", kind: "text", required: true, flag: "name" }, { key: "address", label: "Management address", kind: "text", required: true, flag: "address" }, { key: "privateAddress", label: "Private address", kind: "text", required: true, flag: "private-address" }, { key: "hostKey", label: "SSH host key", kind: "text", required: true, flag: "host-key" }, { key: "sshUser", label: "SSH user", kind: "text", flag: "ssh-user", defaultValue: "root" }, positiveNumber("sshPort", "SSH port", { flag: "ssh-port", defaultValue: "22", max: 65535 }), { key: "pool", label: "Pool", kind: "text", flag: "pool", defaultValue: "general" }] },
  { id: "servers.pool", category: "Servers", label: "Change pool", description: "Change a server's future-placement pool.", args: ["servers", "pool"], inputs: [server(), { key: "pool", label: "Pool", kind: "text", required: true, positional: true, placeholder: "general" }] },
  { id: "servers.create", category: "Servers", label: "Provision server", description: "Provision a provider server.", args: ["servers", "create"], inputs: [resource("type", "Server type", "server-type", { required: true, flag: "type" }), resource("location", "Location", "location", { required: true, flag: "location" }), { key: "name", label: "Name", kind: "text", flag: "name" }], danger: true },
  { id: "servers.delete", category: "Servers", label: "Delete server", description: "Permanently destroy an unused server.", args: ["servers", "delete"], inputs: [server()], danger: true },

  { id: "resources.list", category: "Resources", label: "Resource inventory", description: "Show servers, volumes, retention, and estimated cost.", args: ["resources", "ls"], inputs: [] },
  { id: "volumes.list", category: "Resources", label: "List volumes", description: "List provider volumes and retention state.", args: ["volumes", "list"], inputs: [] },
  { id: "volumes.show", category: "Resources", label: "Volume details", description: "Show volume ownership, mount, and cost.", args: ["volumes", "show"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }] },
  { id: "volumes.audit", category: "Resources", label: "Volume deletion audit", description: "Show the durable deletion audit.", args: ["volumes", "audit"], inputs: [] },
  { id: "volumes.files", category: "Resources", label: "Browse volume", description: "List files in an attached volume.", args: ["volumes", "ls"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }, { key: "path", label: "Path", kind: "text", positional: true, placeholder: "subdirectory" }] },
  { id: "volumes.cat", category: "Resources", label: "Read volume file", description: "Read a text file (up to the CLI/API limit).", args: ["volumes", "cat"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }, { key: "path", label: "Path", kind: "text", required: true, positional: true }] },
  { id: "volumes.delete", category: "Resources", label: "Delete volume", description: "Permanently destroy an unused provider volume and its data.", args: ["volumes", "delete"], inputs: [{ key: "volume", label: "Volume", kind: "resource", resource: "volume", required: true, positional: true }], danger: true },
  { id: "buckets.list", category: "Resources", label: "List S3 buckets", description: "List buckets visible to the configured Hetzner S3 credential.", args: ["buckets", "list"], inputs: [] },
  { id: "buckets.create", category: "Resources", label: "Create S3 bucket", description: "Create a private Hetzner S3 bucket.", args: ["buckets", "create"], inputs: [{ key: "bucket", label: "Bucket name", kind: "text", required: true, positional: true }], danger: true },
  { id: "buckets.delete", category: "Resources", label: "Delete S3 bucket", description: "Delete an empty Hetzner S3 bucket. Objects are never recursively removed.", args: ["buckets", "delete"], inputs: [{ key: "bucket", label: "Bucket name", kind: "text", required: true, positional: true }], danger: true },

  { id: "gc.preview", category: "Resources", label: "Preview disk cleanup", description: "Inspect safely reclaimable image data without deleting it.", args: ["gc"], inputs: [{ ...server(), required: false, positional: false, flag: "server" }] },
  { id: "gc.execute", category: "Resources", label: "Execute disk cleanup", description: "Reclaim the assets identified by the safe GC policy.", args: ["gc"], inputs: [{ ...server(), required: false, positional: false, flag: "server" }], fixedArgs: ["--execute"], danger: true },

  { id: "runners.list", category: "Build", label: "List build workers", description: "List BuildKit workers and disk headroom.", args: ["runners", "ls"], inputs: [] },
  { id: "runners.install", category: "Build", label: "Install build worker", description: "Reserve an empty server and install a BuildKit worker.", args: ["runners", "install"], inputs: [{ ...server(), positional: false, flag: "server" }, { key: "name", label: "Worker name", kind: "text", flag: "name" }, { key: "removalToken", label: "Legacy runner removal token", kind: "text", flag: "removal-token-stdin", transport: "stdin" }] },
  { id: "runners.remove", category: "Build", label: "Remove build worker", description: "Remove a worker and restore its server capacity pool.", args: ["runners", "remove"], inputs: [{ key: "runner", label: "Build worker", kind: "text", required: true, positional: true }], danger: true },
  { id: "runners.sources", category: "Build", label: "List build sources", description: "List repository and branch webhook sources.", args: ["runners", "sources"], inputs: [] },
  { id: "runners.webhook-secret", category: "Build", label: "Rotate webhook secret", description: "Rotate and reveal a source webhook secret once.", args: ["runners", "webhook-secret"], inputs: [positiveNumber("source", "Build source", { required: true, positional: true })], danger: true },
  { id: "registry.login", category: "Build", label: "Connect OCI registry", description: "Store an encrypted repository-namespace-scoped push/pull credential.", args: ["registry", "login"], inputs: [{ key: "scope", label: "Repository namespace", kind: "text", required: true, positional: true }, { key: "username", label: "Username", kind: "text", required: true, flag: "username" }, { key: "token", label: "Password / token", kind: "text", required: true, flag: "token-stdin", transport: "stdin" }] },
  { id: "registry.logout", category: "Build", label: "Disconnect OCI registry", description: "Remove the stored registry credential.", args: ["registry", "logout"], inputs: [], danger: true },
  { id: "source.login", category: "Build", label: "Connect private source", description: "Store an encrypted host-scoped Git checkout credential.", args: ["source", "login"], inputs: [{ key: "host", label: "Git host", kind: "text", required: true, positional: true }, { key: "username", label: "Username", kind: "text", required: true, flag: "username" }, { key: "token", label: "Read-only token", kind: "text", required: true, flag: "token-stdin", transport: "stdin" }] },
  { id: "source.logout", category: "Build", label: "Disconnect private source", description: "Remove the stored private Git credential.", args: ["source", "logout"], inputs: [], danger: true },

  { id: "manifest.validate", category: "Deploy", label: "Validate manifest", description: "Validate an app or stack manifest and its children.", args: ["manifest", "validate"], inputs: [{ key: "manifest", label: "Manifest path", kind: "text", required: true, positional: true }, { key: "allowUnknown", label: "Allow unknown manifest keys", kind: "boolean", flag: "allow-unknown" }] },

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
  return buildWebCliInvocation(command, values).argv;
}

export function buildWebCliInvocation(
  command: WebCliCommand,
  values: WebCliValues,
): { argv: string[]; stdin?: string } {
  if (command.unavailableReason) throw new Error(command.unavailableReason);
  const known = new Set(command.inputs.map((input) => input.key));
  for (const key of Object.keys(values)) {
    // UI state may retain cleared contextual fields while switching commands.
    // An absent value is not a supplied parameter and must not make an otherwise
    // valid command fail (for example app rollback -> app show).
    if (values[key] !== undefined && !known.has(key)) throw new Error(`Unknown parameter: ${key}`);
  }

  const positional: string[] = [];
  const flags: string[] = [];
  const secretVars: Array<{ key: string; value: string }> = [];
  const setVars: string[] = [];
  const stagingSetVars: string[] = [];
  let stdinValue: string | undefined;
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
      if (
        input.kind === "resource" &&
        input.resource &&
        ["operation", "deployment", "replica"].includes(input.resource) &&
        !/^[1-9]\d*$/.test(value)
      ) {
        throw new Error(`${input.label} has an invalid ID`);
      }
      if (input.kind === "key-value" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        throw new Error(`${input.label} entries must use KEY=VALUE`);
      }
      if (input.transport === "secret-vars") {
        const equals = value.indexOf("=");
        secretVars.push({ key: value.slice(0, equals), value: value.slice(equals + 1) });
        continue;
      }
      if (input.transport === "stdin") {
        if (stdinValue !== undefined) throw new Error("Only one stdin value is supported");
        stdinValue = value;
        if (input.flag) flags.push(`--${input.flag}`);
        continue;
      }
      if (input.transport === "set-vars" || input.transport === "staging-set-vars") {
        (input.transport === "set-vars" ? setVars : stagingSetVars).push(value);
        continue;
      }
      if (input.positional) {
        if (value.startsWith("-")) throw new Error(`${input.label} cannot start with a dash`);
        positional.push(value);
      }
      else if (input.flag) flags.push(`--${input.flag}=${value}`);
    }
  }
  const argv = [
    ...command.args,
    ...positional,
    ...flags,
    ...(secretVars.length ? ["--secrets-stdin"] : []),
    ...(setVars.length || stagingSetVars.length ? ["--sets-stdin"] : []),
    ...(command.fixedArgs || []),
  ];
  if (argv.reduce((total, value) => total + value.length, 0) > 64 * 1024) {
    throw new Error("Command parameters are too large");
  }
  const transportCount = Number(secretVars.length > 0) + Number(stdinValue !== undefined) + Number(setVars.length > 0 || stagingSetVars.length > 0);
  if (transportCount > 1) throw new Error("Multiple stdin transports cannot be combined");
  const stdin = secretVars.length
    ? JSON.stringify(secretVars)
    : setVars.length || stagingSetVars.length
      ? JSON.stringify({ sets: setVars, staging_sets: stagingSetVars })
      : stdinValue;
  if (stdin && stdin.length > 256 * 1024) throw new Error("Secret parameters are too large");
  return { argv, stdin };
}
