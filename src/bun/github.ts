import { secretStore } from "./secret-store.ts";

function log(context: string, ...args: any[]) {
  console.log(`[${new Date().toISOString()}] [github:${context}]`, ...args);
}

async function githubApi(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<any> {
  const method = options.method || "GET";
  log("api", `${method} ${path}`);
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
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
  return res.json();
}

export function parseGitHubRepo(url: string): { owner: string; repo: string } {
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

  log("webhook", `Webhook created: id=${data.id}`);
  return { id: data.id };
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
  log("webhook", `Webhook created: id=${data.id}`);
  return { id: data.id };
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

export async function getGitHubPat(): Promise<string | null> {
  const pat = await secretStore.get("github_pat");
  return pat || null;
}
