// Lightweight GitHub repo introspection — peeks at a public (or token-scoped)
// repo via the GitHub Contents API and pulls out the few things our deploy
// flow needs to autofill: Dockerfile path(s), docker-compose file + likely
// web service, an EXPOSE'd port, and env var keys from a .env.example.
//
// Everything here is best-effort. If anything fails (rate limit, private
// repo, missing files, parse error) we degrade gracefully — the frontend
// just falls back to the manual fields.

import { parseGitHubRepo, getGitHubPat } from "./github.ts";
import { validateDeployManifest } from "./validate.ts";
import type { ParsedManifest } from "../shared/rpc.ts";

export type IntrospectResult = {
  ok: true;
  owner: string;
  repo: string;
  default_branch: string;
  suggested_app_name: string;
  dockerfiles: string[];
  compose_files: string[];
  compose_services: Array<{ name: string; port: number | null; has_ports: boolean }>;
  suggested_web_service: string | null;
  detected_port: number | null;
  env_vars: Array<{ key: string; value: string }>;
  manifests: ParsedManifest[];
  notes: string[];
} | {
  ok: false;
  error: string;
  suggested_app_name?: string;
};

const WEB_SERVICE_HINTS = ["web", "app", "frontend", "server", "api", "www", "site"];

function sanitizeAppName(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "my-app";
}

async function ghFetch(path: string, token: string | null): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string | null,
): Promise<string | null> {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    token,
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data && typeof data.content === "string" && data.encoding === "base64") {
    try {
      return Buffer.from(data.content, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

// Tiny purpose-built compose parser. We don't need full YAML — we just need
// the names of services under `services:` and whether each one has a `ports:`
// block (and if so, the host port from the first mapping).
function parseCompose(yaml: string): Array<{ name: string; port: number | null; has_ports: boolean }> {
  const lines = yaml.split(/\r?\n/);
  const services: Array<{ name: string; port: number | null; has_ports: boolean }> = [];

  // Find the `services:` block (top-level, indent 0)
  let i = 0;
  while (i < lines.length && !/^services:\s*$/.test(lines[i])) i++;
  if (i >= lines.length) return services;
  i++;

  // Service entries are indented; assume 2-space indent (the overwhelming convention).
  // A service starts with `  <name>:` and runs until the next 2-space line or EOF.
  let current: { name: string; port: number | null; has_ports: boolean } | null = null;
  let inPorts = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // End of services block — top-level key with no leading spaces
    if (/^[A-Za-z]/.test(line)) break;

    const serviceMatch = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (serviceMatch) {
      if (current) services.push(current);
      current = { name: serviceMatch[1], port: null, has_ports: false };
      inPorts = false;
      continue;
    }

    if (!current) continue;

    // `    ports:` or `    ports: [...]`
    if (/^ {4}ports:\s*(\[.*\])?\s*$/.test(line)) {
      current.has_ports = true;
      inPorts = true;
      // Inline list form: ports: ["80:80"]
      const inline = line.match(/\[(.*)\]/);
      if (inline && current.port == null) {
        const m = inline[1].match(/['"]?(\d+)(?::\d+)?['"]?/);
        if (m) current.port = parseInt(m[1], 10);
      }
      continue;
    }

    // Leaving ports if we hit another sibling key at the same indent
    if (inPorts && /^ {4}[A-Za-z]/.test(line)) inPorts = false;

    if (inPorts && current.port == null) {
      // - "3000:3000" or - 3000:3000 or - "3000"
      const m = line.match(/^\s*-\s*['"]?(\d+)(?::\d+)?['"]?/);
      if (m) current.port = parseInt(m[1], 10);
    }
  }
  if (current) services.push(current);
  return services;
}

function parseDockerfileExpose(dockerfile: string): number | null {
  // Match the first EXPOSE line. Supports `EXPOSE 3000`, `EXPOSE 3000/tcp`,
  // or `EXPOSE ${PORT}` (which we skip). Ignores commented lines.
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^EXPOSE\s+(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function parseEnvExample(content: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    let value = m[2].trim();
    // Strip a single layer of matched quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Drop trailing inline comments on unquoted values
    if (!m[2].trim().startsWith('"') && !m[2].trim().startsWith("'")) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    out.push({ key, value });
  }
  return out;
}

// Prefer an .env.example sibling of the Dockerfile, then walk up to repo root.
// Falls back to any .env.example anywhere in the tree (shallowest first) so
// single-Dockerfile-at-root repos still work.
function pickEnvExample(paths: string[], dockerfilePath: string | null): string | null {
  const isEnv = (p: string) => /(^|\/)\.env\.(example|sample|template)$/i.test(p);
  const envPaths = paths.filter(isEnv);
  if (envPaths.length === 0) return null;

  if (dockerfilePath) {
    const slash = dockerfilePath.lastIndexOf("/");
    let dir = slash >= 0 ? dockerfilePath.slice(0, slash) : "";
    while (true) {
      const prefix = dir ? dir + "/" : "";
      const match = envPaths.find((p) => {
        if (!p.startsWith(prefix)) return false;
        return p.slice(prefix.length).indexOf("/") === -1;
      });
      if (match) return match;
      if (!dir) break;
      const up = dir.lastIndexOf("/");
      dir = up >= 0 ? dir.slice(0, up) : "";
    }
  }

  return envPaths.sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? null;
}

function pickWebService(
  services: Array<{ name: string; port: number | null; has_ports: boolean }>,
): string | null {
  if (services.length === 0) return null;
  // Prefer a service with a hint name AND ports
  for (const hint of WEB_SERVICE_HINTS) {
    const match = services.find((s) => s.name.toLowerCase() === hint && s.has_ports);
    if (match) return match.name;
  }
  // Else any service with ports
  const withPorts = services.find((s) => s.has_ports);
  if (withPorts) return withPorts.name;
  // Else first hint match without ports
  for (const hint of WEB_SERVICE_HINTS) {
    const match = services.find((s) => s.name.toLowerCase() === hint);
    if (match) return match.name;
  }
  return services[0].name;
}

export async function introspectRepo(url: string, userId?: string): Promise<IntrospectResult> {
  let parsed: { owner: string; repo: string };
  try {
    parsed = parseGitHubRepo(url);
  } catch {
    return {
      ok: false,
      error: "We couldn't read that URL. Paste a GitHub repo link like https://github.com/owner/repo.",
    };
  }

  const { owner, repo } = parsed;
  const suggested_app_name = sanitizeAppName(repo);
  const token = await getGitHubPat(userId);

  // 1. Fetch repo info to get the default branch
  const repoRes = await ghFetch(`/repos/${owner}/${repo}`, token);
  if (repoRes.status === 404) {
    return {
      ok: false,
      error: "Repository not found. If it's private, link your GitHub account in Account settings.",
      suggested_app_name,
    };
  }
  if (repoRes.status === 401 || repoRes.status === 403) {
    return {
      ok: false,
      error: "GitHub denied the request — your token may be missing or out of API quota.",
      suggested_app_name,
    };
  }
  if (!repoRes.ok) {
    return { ok: false, error: `GitHub error (HTTP ${repoRes.status})`, suggested_app_name };
  }
  const repoData = await repoRes.json();
  const default_branch: string = repoData.default_branch || "main";

  // 2. Fetch the recursive git tree
  const notes: string[] = [];
  const treeRes = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(default_branch)}?recursive=1`,
    token,
  );
  if (!treeRes.ok) {
    return {
      ok: true,
      owner,
      repo,
      default_branch,
      suggested_app_name,
      dockerfiles: [],
      compose_files: [],
      compose_services: [],
      suggested_web_service: null,
      detected_port: null,
      env_vars: [],
      manifests: [],
      notes: ["We couldn't read the repo tree, so you'll need to fill in the rest manually."],
    };
  }
  const tree = await treeRes.json();
  const paths: string[] = (tree.tree || [])
    .filter((e: any) => e.type === "blob")
    .map((e: any) => e.path as string);
  if (tree.truncated) notes.push("Repo is large — some files may have been skipped.");

  // 3. Discover .ocd-deploy.json manifests
  const manifestPaths = paths
    .filter((p) => /(^|\/)\.ocd-deploy\.json$/.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length); // shallowest first

  if (manifestPaths.length > 10) {
    notes.push(`Found ${manifestPaths.length} deploy manifests — only the first 10 will be loaded.`);
  }

  const manifests: ParsedManifest[] = [];
  const manifestContents = await Promise.all(
    manifestPaths.slice(0, 10).map((p) => fetchRawFile(owner, repo, default_branch, p, token)),
  );
  for (let i = 0; i < manifestContents.length; i++) {
    const content = manifestContents[i];
    const mPath = manifestPaths[i];
    if (!content) {
      notes.push(`Could not read ${mPath} — skipping.`);
      continue;
    }
    try {
      const raw = JSON.parse(content);
      const result = validateDeployManifest(raw);
      if (!result.ok) {
        notes.push(`${mPath}: ${result.error} — skipping.`);
        continue;
      }
      const slash = mPath.lastIndexOf("/");
      const dir = slash >= 0 ? mPath.slice(0, slash) : "";
      // Resolve relative paths in build
      const m = result.manifest;
      if (m.build && dir) {
        if (m.build.dockerfile) m.build.dockerfile = `${dir}/${m.build.dockerfile}`;
        if (m.build.compose_file) m.build.compose_file = `${dir}/${m.build.compose_file}`;
      }
      manifests.push({ path: mPath, dir, manifest: m });
    } catch {
      notes.push(`${mPath} is not valid JSON — skipping.`);
    }
  }

  // 4. Find candidate files
  const dockerfiles = paths
    .filter((p) => /(^|\/)Dockerfile(\.[A-Za-z0-9_-]+)?$/.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length); // shallowest first

  const composeFiles = paths
    .filter((p) => /(^|\/)(?:docker-compose|compose)\.ya?ml$/.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length); // shallowest first

  const envExampleCandidate = pickEnvExample(paths, dockerfiles[0] ?? null);

  // 4. Read the chosen files in parallel
  const [composeContent, dockerfileContent, envContent] = await Promise.all([
    composeFiles[0] ? fetchRawFile(owner, repo, default_branch, composeFiles[0], token) : Promise.resolve(null),
    dockerfiles[0] ? fetchRawFile(owner, repo, default_branch, dockerfiles[0], token) : Promise.resolve(null),
    envExampleCandidate ? fetchRawFile(owner, repo, default_branch, envExampleCandidate, token) : Promise.resolve(null),
  ]);

  let compose_services: Array<{ name: string; port: number | null; has_ports: boolean }> = [];
  let suggested_web_service: string | null = null;
  let detected_port: number | null = null;

  if (composeContent) {
    try {
      compose_services = parseCompose(composeContent);
      suggested_web_service = pickWebService(compose_services);
      const webSvc = compose_services.find((s) => s.name === suggested_web_service);
      if (webSvc?.port) detected_port = webSvc.port;
    } catch {
      notes.push("Found a compose file but couldn't read it — we'll detect it again at deploy time.");
    }
  }

  if (detected_port == null && dockerfileContent) {
    detected_port = parseDockerfileExpose(dockerfileContent);
  }

  const env_vars = envContent ? parseEnvExample(envContent) : [];

  if (dockerfiles.length === 0 && composeFiles.length === 0) {
    notes.push("No Dockerfile or compose file found — you'll need to add one before deploying.");
  }

  return {
    ok: true,
    owner,
    repo,
    default_branch,
    suggested_app_name,
    dockerfiles,
    compose_files: composeFiles,
    compose_services,
    suggested_web_service,
    detected_port,
    env_vars,
    manifests,
    notes,
  };
}
