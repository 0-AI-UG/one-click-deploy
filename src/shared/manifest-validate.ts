/**
 * Fail-fast, field-level schema validation for deploy (`.ocd-deploy.json`) and
 * stack (`ocd-stack.json`) manifests. Thin wrapper over the canonical Zod
 * schemas in `./manifest-schema.ts` (the single source of truth from which the
 * manifest TypeScript types are also derived) so the shape and the validator
 * can never drift.
 *
 * These validators THROW a single Error listing every issue found (file + field
 * path + expected-vs-got), so a bad manifest is rejected BEFORE the deploy
 * engine ever sees it.
 *
 * Wrong-typed KNOWN keys are hard errors; UNKNOWN keys are a non-fatal stderr
 * warning so forward-compat manifests still deploy. This maps onto Zod as:
 * schema `.strict()` reports unknown keys as `unrecognized_keys` issues, which
 * we turn into `console.warn`s and DO NOT count as errors; every other issue
 * code is a hard error.
 */
import type { z } from "zod";
import {
  DeployManifestSchema,
  StackManifestSchema,
  got,
} from "./manifest-schema.ts";

// Re-export the canonical schemas + inferred types so callers have one import
// site for "the manifest shape".
export {
  DeployManifestSchema,
  StackManifestSchema,
  type DeployManifest,
  type StackManifest,
} from "./manifest-schema.ts";

type Issue = z.core.$ZodIssue;
type PathSeg = string | number;

/** Render a Zod issue path as a field label: `build.container_port`, `env[0].key`,
 *  `apps.web.needs[0]`. */
function fieldPath(path: readonly PathSeg[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** Walk the raw manifest along an issue path to recover the received value, so
 *  we can render it with `got()` (Zod strips the value from most issues). */
function valueAt(root: unknown, path: readonly PathSeg[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PathSeg, unknown>)[seg];
  }
  return cur;
}

/**
 * Turn one non-`unrecognized_keys` Zod issue into an "field: expected … got …"
 * line matching the old hand-written wording.
 *
 * - `custom` issues (our `refine`/`superRefine` messages) are already fully
 *   authored — including the `, got …` suffix where wanted — so we use them
 *   verbatim.
 * - Every other (built-in) issue's message is just the "expected …" phrase we
 *   attached to the field; we append `, got <received>` (or ` (required)` when
 *   a top-level `name` is missing, matching the old copy).
 */
function renderIssue(issue: Issue, root: unknown): string {
  const path = issue.path as PathSeg[];
  const field = fieldPath(path);
  const value = valueAt(root, path);

  let msg: string;
  if (issue.code === "custom") {
    msg = issue.message;
  } else if (path.length === 0) {
    // The whole manifest was the wrong type (not an object).
    return `expected a JSON object, got ${got(value)}`;
  } else if (path.length === 1 && path[0] === "name" && value === undefined) {
    msg = `${issue.message} (required)`;
  } else {
    msg = `${issue.message}, got ${got(value)}`;
  }
  return field ? `${field}: ${msg}` : msg;
}

/** Run a schema, warn on unknown keys, throw one Error listing all hard issues. */
function runValidation(
  schema: typeof DeployManifestSchema | typeof StackManifestSchema,
  manifest: unknown,
  sourcePath: string,
  kind: "manifest" | "stack manifest",
): void {
  const result = schema.safeParse(manifest);
  if (result.success) return;

  const errors: string[] = [];
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        // eslint-disable-next-line no-console
        console.warn(`Manifest ${sourcePath}: unknown key "${key}" (ignored)`);
      }
      continue;
    }
    errors.push(renderIssue(issue, manifest));
  }

  // Only unknown keys → warn (already done) and pass; no hard errors to throw.
  if (errors.length === 0) return;

  const header = `Invalid ${kind} ${sourcePath}:`;
  const bullets = errors.map((e) => `  • ${e}`).join("\n");
  throw new Error(`${header}\n${bullets}`);
}

/**
 * Validate an app manifest (`.ocd-deploy.json`). Throws with a field-level
 * message listing ALL issues when it doesn't conform to `DeployManifest`.
 */
export function validateDeployManifest(manifest: unknown, sourcePath: string): void {
  runValidation(DeployManifestSchema, manifest, sourcePath, "manifest");
}

/**
 * Validate the TOP-LEVEL structure of a stack manifest (`ocd-stack.json`).
 * Does NOT read the referenced child `.ocd-deploy.json` files — those are
 * validated separately through `readManifest`/`validateDeployManifest`.
 * Throws with a field-level message listing ALL issues.
 */
export function validateStackManifest(manifest: unknown, sourcePath: string): void {
  runValidation(StackManifestSchema, manifest, sourcePath, "stack manifest");
}
