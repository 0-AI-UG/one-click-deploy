import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { BOLD, DIM, RED, RESET } from "./format.ts";
import { promptLine, promptHidden } from "./prompt.ts";
import type { DeployManifest } from "../shared/rpc.ts";
import type { RequiredMissing } from "../shared/env-merge.ts";
import { validateDeployManifest } from "../shared/manifest-validate.ts";

/** Stable provenance for the exact manifest bytes the caller applied. */
export function manifestHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Prompt (grouped) for required env vars that the merge could not fill from a
 * default, a --set, or an existing environment. Non-TTY → hard error listing
 * the missing keys. Returns concrete entries to append to the deploy env.
 */
export async function promptRequired(
  missing: RequiredMissing[],
  header = "Required environment variables",
): Promise<Array<{ key: string; value: string; secret: boolean }>> {
  if (missing.length === 0) return [];
  if (!process.stdin.isTTY) {
    console.error(`${RED}Missing required env vars: ${missing.map((e) => e.key).join(", ")}${RESET}`);
    console.error(`Provide them with --set=KEY=VALUE or declare manifest.environment.`);
    process.exit(1);
  }
  console.log(`\n${BOLD}${header}${RESET}`);
  const out: Array<{ key: string; value: string; secret: boolean }> = [];
  for (const entry of missing) {
    const hint = entry.description ? ` ${DIM}(${entry.description})${RESET}` : "";
    const question = `  ${entry.key}${hint}: `;
    let value = "";
    while (!value) {
      value = entry.secret ? await promptHidden(question) : await promptLine(question);
    }
    out.push({ key: entry.key, value, secret: entry.secret });
  }
  return out;
}

function repositoryRoot(path: string): string {
  const result = Bun.spawnSync(["git", "-C", dirname(resolve(path)), "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const root = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !root) {
    throw new Error("OCD build manifests must be inside a Git checkout");
  }
  return root;
}

/** Resolve a local manifest relative to the repository checkout root. */
export function manifestRepoLocation(path: string): { path: string; dir: string; fullPath: string; repoRoot: string } {
  const fullPath = resolve(path);
  const repoRoot = repositoryRoot(fullPath);
  const repoPath = relative(repoRoot, fullPath).replaceAll("\\", "/");
  const dir = relative(repoRoot, dirname(fullPath)).replaceAll("\\", "/");
  if (repoPath.startsWith("../")) throw new Error("Manifest is outside its Git checkout");
  return { path: repoPath, dir: dir === "." ? "" : dir, fullPath, repoRoot };
}

/** Resolve the exact local checkout revision used for an OCD build request. */
export function localGitCommit(path = process.cwd()): string {
  const root = repositoryRoot(path);
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const commit = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error("OCD builds require a Git checkout; could not resolve the current commit");
  }
  return commit;
}

/** Read + JSON.parse a `.ocd-deploy.json` manifest, exiting on error. */
export function readManifest(path: string, options: { allowUnknown?: boolean } = {}): DeployManifest {
  let manifest: DeployManifest;
  try {
    const raw = readFileSync(path, "utf-8");
    manifest = JSON.parse(raw) as DeployManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${RED}Manifest not found: ${path}${RESET}`);
    } else {
      console.error(`${RED}Failed to read manifest: ${err instanceof Error ? err.message : err}${RESET}`);
    }
    process.exit(1);
  }
  // Schema-validate right after parse so a malformed manifest fails fast with a
  // clear, field-level error before it ever reaches the deploy engine. Covers
  // both single-app `ocd deploy` and every stack child manifest (`ocd stack up`
  // calls readManifest per app entry).
  try {
    validateDeployManifest(manifest, path, options);
  } catch (err) {
    console.error(`${RED}${err instanceof Error ? err.message : err}${RESET}`);
    process.exit(1);
  }
  // Keep the established verbose form (`image: { ref }`) compatible with the
  // shorthand string, then expose one normalized shape to every deploy path.
  const rawImage = (manifest as unknown as { image?: string | { ref: string } }).image;
  if (rawImage && typeof rawImage === "object") manifest.image = rawImage.ref;
  return manifest;
}

/**
 * Resolve declarative basic-auth intent without ever putting a plaintext
 * password in the manifest. Disabled auth returns an empty string (the wire
 * protocol's explicit "clear auth" value); enabled auth reads password_env or
 * prompts on a TTY.
 */
export async function resolveAuthPassword(
  auth: DeployManifest["auth"],
  passwordEnvOverride?: string,
): Promise<string | undefined> {
  if (!auth) return undefined;
  if (!auth.enabled) return "";
  const envKey = passwordEnvOverride || auth.password_env;
  if (envKey) {
    const value = process.env[envKey];
    if (value) return value;
    if (!process.stdin.isTTY) {
      throw new Error(`Basic auth password environment variable ${envKey} is not set`);
    }
  } else if (!process.stdin.isTTY) {
    throw new Error(
      "Basic auth is enabled but no password is available; set auth.password_env or use --auth-password-env",
    );
  }
  let password = "";
  while (!password) password = await promptHidden("  Basic auth password: ");
  return password;
}

/**
 * Resolve the manifest's env[] section into concrete values: --set overrides
 * (per-app `sets`), then a shared `fallback` lookup (used only for declared
 * vars, never added as extras), then manifest defaults, then interactive
 * prompts for required vars. `header` labels the prompt group.
 */
export async function collectEnvVars(
  manifest: DeployManifest,
  sets: Record<string, string>,
  opts?: { fallback?: Record<string, string>; header?: string },
): Promise<Array<{ key: string; value: string; secret?: boolean }>> {
  const fallback = opts?.fallback || {};
  const header = opts?.header || "Required environment variables";
  const out: Array<{ key: string; value: string; secret?: boolean }> = [];
  const remaining = { ...sets };

  const toPrompt: NonNullable<DeployManifest["env"]> = [];
  const randomPassword = (length = 32): string => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  };
  for (const entry of manifest.env || []) {
    if (entry.key in remaining) {
      out.push({ key: entry.key, value: remaining[entry.key], secret: entry.secret });
      delete remaining[entry.key];
    } else if (entry.key in fallback) {
      out.push({ key: entry.key, value: fallback[entry.key], secret: entry.secret });
    } else if (entry.default !== undefined) {
      out.push({ key: entry.key, value: entry.default, secret: entry.secret });
    } else if (entry.generate) {
      out.push({
        key: entry.key,
        value: entry.generate === "username" ? "ocd_user" : randomPassword(),
        secret: entry.secret,
      });
    } else if (entry.required) {
      toPrompt.push(entry);
    }
  }

  // Extra --set keys not declared in the manifest (app-specific sets only;
  // shared fallback keys that match no declared var are intentionally ignored).
  for (const [key, value] of Object.entries(remaining)) {
    out.push({ key, value });
  }

  if (toPrompt.length > 0) {
    if (!process.stdin.isTTY) {
      console.error(
        `${RED}Missing required env vars: ${toPrompt.map((e) => e.key).join(", ")}${RESET}`,
      );
      console.error(`Provide them with --set=KEY=VALUE or declare manifest.environment.`);
      process.exit(1);
    }
    console.log(`\n${BOLD}${header}${RESET}`);
    for (const entry of toPrompt) {
      const hint = entry.description ? ` ${DIM}(${entry.description})${RESET}` : "";
      const question = `  ${entry.key}${hint}: `;
      let value = "";
      while (!value) {
        value = entry.secret ? await promptHidden(question) : await promptLine(question);
      }
      out.push({ key: entry.key, value, secret: entry.secret });
    }
  }

  return out;
}
