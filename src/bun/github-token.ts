import { secretStore } from "./secret-store.ts";

/**
 * Resolve the GitHub token for a user's git/registry operations.
 * Returns the user's personal OAuth token, or empty string if not linked.
 */
export async function resolveGitHubToken(userId?: string): Promise<string> {
  if (userId) {
    const userToken = await secretStore.get(`github_oauth:${userId}`);
    if (userToken) return userToken;
  }
  return "";
}
