import type { DeployRequest } from "./rpc.ts";

import { RuntimeEnvSchema, RuntimeOutputsSchema, type RuntimeEnv, type RuntimeOutputs } from "./manifest-schema.ts";
export type { RuntimeEnv, RuntimeOutputs } from "./manifest-schema.ts";
export type RuntimeConfig = { env: RuntimeEnv; outputs: RuntimeOutputs };
export type RuntimeApp = {
  name: string; container_port: number; internal_protocol: string;
  environment_id: number | null; stack_id: number | null; env_vars: string;
};
export type RuntimeContext = {
  apps?: RuntimeApp[];
  stackNames?: Record<number, string>;
  environment?: (id: number) => Record<string, string> | Promise<Record<string, string>>;
};

export function parseRuntimeConfig(raw: string): RuntimeConfig {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "env" && key !== "outputs")) {
    throw new Error("App runtime configuration must contain only env and outputs maps");
  }
  return { env: RuntimeEnvSchema.parse(parsed.env ?? {}), outputs: RuntimeOutputsSchema.parse(parsed.outputs ?? {}) };

}
export function serializeRuntimeConfig(config: { env?: RuntimeEnv; outputs?: RuntimeOutputs }): string {
  return JSON.stringify({ env: config.env ?? {}, outputs: config.outputs ?? {} });
}
export function runtimeAppFromRequest(req: DeployRequest, stackId: number | null = null): RuntimeApp {
  return { name: req.app_name, container_port: req.container_port, internal_protocol: req.internal_protocol ?? "http",
    environment_id: req.environment_id ?? null, stack_id: stackId, env_vars: serializeRuntimeConfig(req) };
}

export async function resolveRuntimeEnv(app: RuntimeApp, context: RuntimeContext = {}): Promise<Record<string, string>> {
  const db = context.apps && context.environment ? null : await import("./db.ts");
  const apps = [...(context.apps ?? db!.getApps()).filter((a) => a.name !== app.name), app];
  const environment = context.environment ?? (async (id: number) => {
    const row = db!.getEnvironment(id);
    if (!row) throw new Error(`Environment #${id} not found`);
    return (await import("./env-crypto.ts")).resolveEnvVarsForDeploy(row.env_vars);
  });
  const values = new Map<string, string>();
  const pending = new Set<string>();
  const environments = new Map<number, Promise<Record<string, string>>>();
  async function resolve(node: RuntimeApp, kind: "env" | "outputs", key: string): Promise<string> {
    const identity = `${node.name}.${kind}.${key}`;
    if (values.has(identity)) return values.get(identity)!;
    if (pending.has(identity)) throw new Error(`Runtime reference cycle at ${identity}`);
    pending.add(identity);
    const config = parseRuntimeConfig(node.env_vars);
    let value: string;
    if (kind === "env") {
      const entry = config.env[key];
      if (entry === undefined) throw new Error(`Missing runtime variable ${identity}`);
      if (typeof entry === "string") value = entry;
      else if (entry.from.startsWith("environment.")) {
        const sourceKey = entry.from.slice("environment.".length);
        if (node.environment_id === null) throw new Error(`${identity} references an environment but none is selected`);
        if (!environments.has(node.environment_id)) environments.set(node.environment_id, Promise.resolve(environment(node.environment_id)));
        const source = await environments.get(node.environment_id)!;
        if (!Object.hasOwn(source, sourceKey)) throw new Error(`Missing environment variable ${sourceKey} required by ${identity}`);
        value = source[sourceKey]!;
      } else {
        const match = /^apps\.([a-z0-9][a-z0-9-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry.from);
        if (!match || node.stack_id === null) throw new Error(`Invalid output reference ${entry.from} in ${identity}`);
        const stackName = context.stackNames?.[node.stack_id] ?? db?.getStack(node.stack_id)?.name;
        const target = apps.find((candidate) => candidate.stack_id === node.stack_id && candidate.name === `${stackName}-${match[1]}`);
        if (!target) throw new Error(`Missing stack member ${match[1]} required by ${identity}`);
        value = await resolve(target, "outputs", match[2]!);
      }
    } else {
      const output = config.outputs[key];
      if (!output) throw new Error(`Missing app output ${identity}`);
      const tokens = [...output.template.matchAll(/\{([^{}]+)\}/g)];
      const replacements = new Map<string, string>();
      for (const token of tokens) {
        const expression = token[1]!;
        let replacement: string;
        if (expression === "app.host") replacement = `${node.name}.ocd.internal`;
        else if (expression === "app.port") replacement = String(node.internal_protocol === "tcp" ? node.container_port : 80);
        else if (/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) replacement = await resolve(node, "env", expression.slice(4));
        else throw new Error(`Invalid output template token ${expression} in ${identity}`);
        replacements.set(token[0], replacement);
      }
      value = output.template.replace(/\{([^{}]+)\}/g, (token) => replacements.get(token)!);
    }
    if (/[\r\n\0]/.test(value)) throw new Error(`Runtime value ${identity} contains a newline or NUL unsupported by container env files`);
    pending.delete(identity);
    values.set(identity, value);
    return value;
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(parseRuntimeConfig(app.env_vars).env)) result[key] = await resolve(app, "env", key);
  for (const key of Object.keys(parseRuntimeConfig(app.env_vars).outputs)) await resolve(app, "outputs", key);
  return result;
}
export async function preflightRuntimeEnv(app: RuntimeApp, context: RuntimeContext = {}): Promise<void> {
  await resolveRuntimeEnv(app, context);
}

/** Follow only referenced output inputs, so unrelated shared keys do not roll apps. */
export function affectedAppsForEnvironmentKeys<T extends RuntimeApp>(apps: T[], environmentId: number, keys: string[], stackNames: Record<number, string> = {}): T[] {
  const changed = new Set(keys);
  function depends(app: T, kind: "env" | "outputs", key: string, seen: Set<string>): boolean {
    const identity = `${app.name}.${kind}.${key}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const config = parseRuntimeConfig(app.env_vars);
    if (kind === "outputs") return [...(config.outputs[key]?.template ?? "").matchAll(/\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].some((match) => depends(app, "env", match[1]!, new Set(seen)));
    const entry = config.env[key];
    if (!entry || typeof entry === "string") return false;
    if (entry.from.startsWith("environment.")) return app.environment_id === environmentId && changed.has(entry.from.slice(12));
    const match = /^apps\.([a-z0-9][a-z0-9-]*)\.outputs\.(\w+)$/.exec(entry.from);
    if (!match || app.stack_id === null) return false;
    const target = apps.find((candidate) => candidate.stack_id === app.stack_id && candidate.name === `${stackNames[app.stack_id!]}-${match[1]}`);
    return !!target && depends(target, "outputs", match[2]!, seen);
  }
  return apps.filter((app) => Object.keys(parseRuntimeConfig(app.env_vars).env).some((key) => depends(app, "env", key, new Set())));
}
