import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCliArgs } from "../args.ts";
import { validateDeployManifest, validateStackManifest } from "../../shared/manifest-validate.ts";
import type { StackManifest } from "../../shared/manifest-schema.ts";
import { GREEN, RESET } from "../format.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function manifest(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "validate") throw new Error("Usage: ocd manifest validate [path] [--allow-unknown]");
  const parsed = parseCliArgs(args.slice(1), {
    "allow-unknown": { type: "boolean" },
  }, { maxPositionals: 1 });
  const defaultPath = existsSync("ocd-stack.json") ? "ocd-stack.json" : ".ocd-deploy.json";
  const path = resolve(parsed.positionals[0] || defaultPath);
  const allowUnknown = parsed.flags["allow-unknown"] === true;
  const result = validateManifestFile(path, { allowUnknown });
  if (result.kind === "app") {
    console.log(`${GREEN}Valid app manifest:${RESET} ${path}`);
  } else {
    console.log(`${GREEN}Valid stack manifest:${RESET} ${path} (${result.childCount} child manifest${result.childCount === 1 ? "" : "s"})`);
  }
}

export function validateManifestFile(
  path: string,
  options: { allowUnknown?: boolean } = {},
): { kind: "app" } | { kind: "stack"; childCount: number } {
  const allowUnknown = options.allowUnknown === true;
  const value = readJson(path);
  const looksLikeStack = !!value && typeof value === "object" && !Array.isArray(value) &&
    ("apps" in value || path.endsWith("ocd-stack.json"));

  if (!looksLikeStack) {
    validateDeployManifest(value, path, { allowUnknown });
    return { kind: "app" };
  }

  validateStackManifest(value, path, { allowUnknown });
  const stack = value as StackManifest;
  let childCount = 0;
  for (const [name, entry] of Object.entries(stack.apps || {})) {
    const childPath = resolve(dirname(path), entry.manifest);
    try {
      validateDeployManifest(readJson(childPath), childPath, { allowUnknown });
    } catch (err) {
      throw new Error(`Stack app ${name}: ${err instanceof Error ? err.message : err}`);
    }
    childCount++;
  }
  return { kind: "stack", childCount };
}
