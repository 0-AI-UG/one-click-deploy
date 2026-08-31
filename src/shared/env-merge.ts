// Unified env-var resolution for deploys. A single app is just a stack with one
// app: its manifest env vars are combined into one environment and layered on
// top of any existing (linked/reused) environment.
//
// Priority per key (highest first):
//   1. --set override      — wins over everything, including an existing env var
//   2. existing env var    — a value already present in the target environment
//   3. manifest default(s) — merged across apps
//   4. generated values    — created once when no persisted value exists
//
// Multiple apps declaring the same key:
//   - only one supplies a (non-empty) default  → use it
//   - several supply differing defaults         → conflict (caller must refuse)
//   - a --set or existing env var covers it     → resolved, no conflict
//
// `entries` are the vars to WRITE into the target environment: --set overrides
// and resolved defaults. Keys already satisfied by the existing environment are
// omitted (existing wins, so there is nothing to write). `requiredMissing` are
// required keys with no default/override/existing value — the caller prompts
// (CLI) or renders an input (web) for them.

export type EnvDef = {
  key: string;
  default?: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
  generate?: "password" | "username";
};

export type AppEnvDefs = { app: string; defs: EnvDef[] };
export type MergedEntry = { key: string; value: string; secret: boolean };
export type EnvConflict = { key: string; apps: string[]; values: string[] };
export type RequiredMissing = { key: string; apps: string[]; secret: boolean; description?: string };

export type MergeResult = {
  entries: MergedEntry[];
  conflicts: EnvConflict[];
  requiredMissing: RequiredMissing[];
};

function randomPassword(length = 32): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function generatedValue(kind: NonNullable<EnvDef["generate"]>): string {
  return kind === "username" ? "ocd_user" : randomPassword();
}

export function mergeEnv(
  apps: AppEnvDefs[],
  overrides: Record<string, string> = {},
  existingKeys: Set<string> = new Set(),
): MergeResult {
  const keys = new Set<string>();
  for (const a of apps) for (const d of a.defs) keys.add(d.key);
  for (const k of Object.keys(overrides)) keys.add(k);

  const entries: MergedEntry[] = [];
  const conflicts: EnvConflict[] = [];
  const requiredMissing: RequiredMissing[] = [];

  for (const key of [...keys].sort()) {
    const declaring = apps
      .map((a) => ({ app: a.app, def: a.defs.find((d) => d.key === key) }))
      .filter((x): x is { app: string; def: EnvDef } => !!x.def);
    const secret = declaring.some((x) => x.def.secret === true);
    const description = declaring.find((x) => x.def.description)?.def.description;

    // 1. --set overrides everything, existing env included.
    if (key in overrides) {
      entries.push({ key, value: overrides[key], secret });
      continue;
    }
    // 2. Existing env var wins over manifest defaults; it is already in the
    //    environment, so there is nothing to write.
    if (existingKeys.has(key)) continue;
    // 3. Merge manifest defaults across the declaring apps.
    const withDefault = declaring.filter((x) => x.def.default !== undefined && x.def.default !== "");
    const distinct = [...new Set(withDefault.map((x) => x.def.default!))];
    if (distinct.length === 1) {
      entries.push({ key, value: distinct[0], secret });
    } else if (distinct.length > 1) {
      conflicts.push({ key, apps: withDefault.map((x) => x.app), values: distinct });
    } else {
      const generators = [...new Set(declaring.map((x) => x.def.generate).filter(Boolean))] as Array<NonNullable<EnvDef["generate"]>>;
      if (generators.length === 1) {
        entries.push({ key, value: generatedValue(generators[0]), secret });
      } else if (generators.length > 1) {
        conflicts.push({ key, apps: declaring.map((x) => x.app), values: generators });
      } else if (declaring.some((x) => x.def.required === true)) {
        requiredMissing.push({ key, apps: declaring.map((x) => x.app), secret, description });
      }
    }
  }

  return { entries, conflicts, requiredMissing };
}
