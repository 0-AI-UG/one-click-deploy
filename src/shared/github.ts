import { resolveGitHubToken } from "./github-token.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [github:${context}]`, ...args);
}

async function githubApi(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<Record<string, unknown> | null> {
  const method = options.method || "GET";
  log("api", `${method} ${path}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      log("api", `${method} ${path} FAILED ${res.status}: ${body}`);
      const friendly = res.status === 401 ? "GitHub token is invalid or expired — update it in Settings"
        : res.status === 403 ? "GitHub access denied — check your token has the required scopes"
        : res.status === 404 ? "GitHub repository or resource not found — check the URL and token permissions"
        : res.status === 422 ? "GitHub rejected the request — the resource may already exist"
        : res.status >= 500 ? "GitHub is experiencing issues — try again shortly"
        : `GitHub error (HTTP ${res.status})`;
      throw new Error(friendly);
    }
    if (res.status === 204) return null;
    return await res.json();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function parseGitHubRepo(url: string): { owner: string; repo: string; ref?: string } {
  // Handle https://github.com/owner/repo/tree/branch-name
  const treeMatch = url.match(
    /github\.com\/([^/]+)\/([^/.]+)\/tree\/([^?#]+)/
  );
  if (treeMatch) {
    return { owner: treeMatch[1], repo: treeMatch[2], ref: treeMatch[3] };
  }
  // Handle https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = url.match(
    /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  // Handle git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)(?:\.git)?/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  throw new Error("Invalid GitHub URL — expected format: https://github.com/owner/repo");
}

export async function createWebhook(opts: {
  gitRepo: string;
  appName: string;
  serverDomain: string;
  webhookSecret: string;
  token: string;
}): Promise<{ id: number }> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);
  const webhookUrl = `https://${opts.serverDomain}/_ocd/webhook/${opts.appName}`;

  log("webhook", `Creating webhook for ${owner}/${repo} -> ${webhookUrl}`);
  const data = await githubApi(`/repos/${owner}/${repo}/hooks`, opts.token, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: webhookUrl,
        content_type: "json",
        secret: opts.webhookSecret,
        insecure_ssl: "0",
      },
    }),
  });

  if (!data) throw new Error("GitHub API returned empty response");
  log("webhook", `Webhook created: id=${data.id}`);
  return { id: data.id as number };
}

export async function createWebhookAtUrl(opts: {
  gitRepo: string;
  url: string;
  webhookSecret: string;
  token: string;
}): Promise<{ id: number }> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);
  log("webhook", `Creating webhook for ${owner}/${repo} -> ${opts.url}`);
  const data = await githubApi(`/repos/${owner}/${repo}/hooks`, opts.token, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: opts.url,
        content_type: "json",
        secret: opts.webhookSecret,
        insecure_ssl: "0",
      },
    }),
  });
  if (!data) throw new Error("GitHub API returned empty response");
  log("webhook", `Webhook created: id=${data.id}`);
  return { id: data.id as number };
}

export async function deleteWebhook(opts: {
  gitRepo: string;
  webhookId: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);
  log("webhook", `Deleting webhook ${opts.webhookId} from ${owner}/${repo}`);
  await githubApi(
    `/repos/${owner}/${repo}/hooks/${opts.webhookId}`,
    opts.token,
    { method: "DELETE" }
  );
  log("webhook", `Webhook ${opts.webhookId} deleted`);
}

export type GitHubWebhook = {
  id: number;
  active: boolean;
  config: { url?: string; content_type?: string; insecure_ssl?: string };
};

export async function listWebhooks(opts: { gitRepo: string; token: string }): Promise<GitHubWebhook[]> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);
  const data = await githubApi(`/repos/${owner}/${repo}/hooks?per_page=100`, opts.token);
  return Array.isArray(data) ? data as unknown as GitHubWebhook[] : [];
}

export async function updateWebhookAtUrl(opts: {
  gitRepo: string;
  webhookId: string;
  url: string;
  webhookSecret: string;
  token: string;
}): Promise<void> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);
  await githubApi(`/repos/${owner}/${repo}/hooks/${opts.webhookId}`, opts.token, {
    method: "PATCH",
    body: JSON.stringify({
      active: true,
      events: ["push"],
      config: {
        url: opts.url,
        content_type: "json",
        secret: opts.webhookSecret,
        insecure_ssl: "0",
      },
    }),
  });
}

// ── Commit CI status ──

export type CiStatus = "pending" | "success" | "failure";

/**
 * Queries the GitHub combined commit status + check runs for a ref.
 * Returns "success" only when all status contexts report success AND
 * all check runs conclude with success/skipped/neutral.
 * Returns "failure" if any report failure/error/cancelled.
 * Returns "pending" otherwise (still running or no checks found).
 */
export async function getCommitCiStatus(opts: {
  gitRepo: string;
  ref: string;
  token: string;
}): Promise<CiStatus> {
  const { owner, repo } = parseGitHubRepo(opts.gitRepo);

  // Combined status (legacy status checks)
  const statusData = await githubApi(
    `/repos/${owner}/${repo}/commits/${opts.ref}/status`,
    opts.token,
  );
  const combinedState = String((statusData as any)?.state ?? "pending");

  // Check Runs (GitHub Actions, etc.)
  const checksData = await githubApi(
    `/repos/${owner}/${repo}/commits/${opts.ref}/check-runs`,
    opts.token,
  );
  const checkRuns = Array.isArray((checksData as any)?.check_runs)
    ? (checksData as any).check_runs as Array<{ status: string; conclusion: string | null }>
    : [];

  // If there are no checks at all, treat as pending (no CI configured yet
  // for this commit — the run hasn't been picked up by GitHub yet).
  const statusContexts = Array.isArray((statusData as any)?.statuses)
    ? (statusData as any).statuses as Array<{ state: string }>
    : [];
  if (statusContexts.length === 0 && checkRuns.length === 0) {
    return "pending";
  }

  // Any failure in legacy statuses?
  if (combinedState === "failure" || combinedState === "error") return "failure";

  // Evaluate check runs
  for (const run of checkRuns) {
    if (run.status !== "completed") return "pending";
    if (run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out" || run.conclusion === "action_required") {
      return "failure";
    }
  }

  // Legacy still pending?
  if (combinedState === "pending" && statusContexts.length > 0) return "pending";

  return "success";
}

export async function getGitHubPat(userId?: string): Promise<string | null> {
  return (await resolveGitHubToken(userId)) || null;
}
