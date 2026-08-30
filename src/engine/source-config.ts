import * as db from "../shared/db.ts";
import { secretStore } from "../shared/secret-store.ts";

export type SourceCredentials = { username?: string; token?: string };

export function repositoryHost(repository: string): string {
  const value = repository.trim();
  try {
    if (/^[a-z]+:\/\//i.test(value)) return new URL(value).hostname.toLowerCase();
  } catch { /* validation happens at the manifest boundary */ }
  const ssh = value.match(/^[^@]+@([^:]+):/);
  return (ssh?.[1] || value.split("/")[0]).toLowerCase();
}

/** Resolve checkout credentials only for the explicitly configured Git host.
 * This prevents a provider token being forwarded to an unrelated repository
 * host from a manifest. */
export async function resolveSourceCredentialsForRepository(
  repository: string,
): Promise<SourceCredentials> {
  const settings = db.getSettings();
  const token = await secretStore.get("github_build_token");
  // Older installations stored only a GitHub token. Retain that compatibility
  // while keeping new/disconnected installations provider-neutral.
  const configuredHost = (settings.github_build_host || (token ? "github.com" : "")).trim().toLowerCase();
  if (!configuredHost || repositoryHost(repository) !== configuredHost) return {};
  return {
    username: token ? (settings.github_build_username || "x-access-token") : undefined,
    token: token || undefined,
  };
}
