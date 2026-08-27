import { get, post } from "../api.ts";
import { parseCliArgs } from "../args.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RESET } from "../format.ts";

type AppSummary = { id: number; name: string };

export async function release(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    image: { type: "string" },
    commit: { type: "string" },
    "idempotency-key": { type: "string" },
    help: { type: "boolean", aliases: ["h"] },
  }, { maxPositionals: 1 });
  if (parsed.flags.help || parsed.positionals.length !== 1) {
    console.log(`${BOLD}Usage:${RESET} ocd release <app> --image <repository@sha256:digest> [options]

Publish an externally-built immutable OCI artifact. OCD pulls and deploys the
exact digest; it never clones source or builds an image.

${BOLD}Options:${RESET}
  --commit <sha>             Optional source revision stored as provenance
  --idempotency-key <key>    Replay-safe CI delivery key

For CI, set OCD_PANEL_URL and OCD_TOKEN instead of running ocd login.`);
    return;
  }
  const image = parsed.flags.image;
  if (typeof image !== "string") throw new Error("--image is required");
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error("--image must be an immutable repository@sha256:<64 hex digest> reference");
  }
  const commit = parsed.flags.commit;
  if (commit !== undefined && (typeof commit !== "string" || !/^[a-f0-9]{7,64}$/i.test(commit))) {
    throw new Error("--commit must contain 7-64 hexadecimal characters");
  }
  const apps = await get<AppSummary[]>("/api/apps");
  const needle = parsed.positionals[0];
  const app = apps.find((candidate) => candidate.name === needle || String(candidate.id) === needle);
  if (!app) throw new Error(`App not found: ${needle}`);
  const explicitKey = parsed.flags["idempotency-key"];
  const githubKey = process.env.GITHUB_RUN_ID
    ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`
    : undefined;
  const idempotencyKey = typeof explicitKey === "string" ? explicitKey : githubKey;
  console.log(`${DIM}App:${RESET}    ${app.name}`);
  console.log(`${DIM}Image:${RESET}  ${image}`);
  if (commit) console.log(`${DIM}Commit:${RESET} ${commit}`);
  const response = await post<{ op_id: number }>(
    `/api/apps/${app.id}/release`,
    { image, ...(commit ? { commit } : {}) },
    idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  );
  const result = await followOp(response.op_id);
  if (!result.ok) throw new Error(result.error || "Release failed");
  console.log(`${GREEN}Released ${BOLD}${app.name}${RESET}${GREEN} at the exact requested digest.${RESET}`);
}
