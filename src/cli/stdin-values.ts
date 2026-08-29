export type StdinSetValues = { sets: string[]; stagingSets: string[] };

/** Read UI-supplied KEY=VALUE overrides without exposing values in process
 * arguments. Local CLI users can continue using the established --set flags. */
export async function readSetValuesFromStdin(): Promise<StdinSetValues> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.stdin.text());
  } catch {
    throw new Error("--sets-stdin expects JSON on stdin");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--sets-stdin expects an object");
  }
  const record = parsed as { sets?: unknown; staging_sets?: unknown };
  const read = (value: unknown, label: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || !value.every((entry) => typeof entry === "string")) {
      throw new Error(`--sets-stdin ${label} must be an array of at most 100 strings`);
    }
    return value as string[];
  };
  return { sets: read(record.sets, "sets"), stagingSets: read(record.staging_sets, "staging_sets") };
}
