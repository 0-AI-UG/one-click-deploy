export type CliFlagSpec = {
  type: "boolean" | "string";
  aliases?: string[];
  repeatable?: boolean;
};

export type CliFlagSchema = Record<string, CliFlagSpec>;

export interface ParsedCliArgs {
  positionals: string[];
  flags: Record<string, boolean | string | string[]>;
}

/**
 * Small strict parser shared by CLI commands. Value flags accept both
 * `--flag=value` and conventional `--flag value` forms. Unknown flags,
 * missing values and unexpected positional arguments fail loudly instead of
 * being silently ignored.
 */
export function parseCliArgs(
  args: string[],
  schema: CliFlagSchema,
  opts: { maxPositionals?: number } = {},
): ParsedCliArgs {
  const flags: ParsedCliArgs["flags"] = {};
  const positionals: string[] = [];
  const aliases = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    aliases.set(name, name);
    for (const alias of spec.aliases ?? []) aliases.set(alias, name);
  }

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const prefix = token.startsWith("--") ? "--" : "-";
    const raw = token.slice(prefix.length);
    const eq = raw.indexOf("=");
    const suppliedName = eq >= 0 ? raw.slice(0, eq) : raw;
    const name = aliases.get(suppliedName);
    if (!name) throw new Error(`Unknown option: ${prefix}${suppliedName}`);
    const spec = schema[name];

    if (spec.type === "boolean") {
      if (eq >= 0) throw new Error(`Option --${name} does not accept a value`);
      flags[name] = true;
      continue;
    }

    const value = eq >= 0 ? raw.slice(eq + 1) : args[++i];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("-"))) {
      throw new Error(`Option --${name} requires a value`);
    }
    if (spec.repeatable) {
      const current = flags[name];
      flags[name] = [...(Array.isArray(current) ? current : []), value];
    } else {
      if (flags[name] !== undefined) throw new Error(`Option --${name} may only be specified once`);
      flags[name] = value;
    }
  }

  if (opts.maxPositionals !== undefined && positionals.length > opts.maxPositionals) {
    throw new Error(`Unexpected argument: ${positionals[opts.maxPositionals]}`);
  }
  return { positionals, flags };
}

export function positiveIntegerFlag(
  value: boolean | string | string[] | undefined,
  name: string,
  opts: { defaultValue?: number; max?: number } = {},
): number | undefined {
  if (value === undefined) return opts.defaultValue;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`--${name} must be an integer from 1 to ${opts.max}`);
  }
  return parsed;
}
