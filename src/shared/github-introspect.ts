// Lightweight GitHub repo introspection — peeks at a public (or token-scoped)
// repo via the GitHub Contents API and pulls out the few things our deploy
// flow needs to autofill: Dockerfile path(s), an EXPOSE'd port, and env var
// keys from a .env.example.
//
// Everything here is best-effort. If anything fails (rate limit, private
// repo, missing files, parse error) we degrade gracefully — the frontend
// just falls back to the manual fields.

import { parseGitHubRepo, getGitHubPat } from "./github.ts";
import { validateDeployManifest } from "./validate.ts";
import { buildStackAppSpec, resolveRepoPath, repoDirOf, type StackAppSpec } from "./stack-spec.ts";
import type { ParsedManifest, StackManifest, StackDeployRequest, DeployManifest } from "./rpc.ts";

// The stack payload resolved from an `ocd-stack.json` — every service plus every
// per-app `.ocd-deploy.json` it references, ready for the builder to edit.
export type StackPayload = {
  stack_path: string;
  name: string;
  description?: string;
  services: StackDeployRequest["services"];
  apps: Array<{
    manifest_path: string;
    env: NonNullable<DeployManifest["env"]>;
    spec: StackAppSpec; // ready to POST once env_vars are filled in
  }>;
  notes: string[];
};

// `introspectRepo` returns a discriminated result: repos with an `ocd-stack.json`
// come back as `kind: "stack"` (the deploy page renders the stack builder);
// everything else is `kind: "app"` (the single-app form). The choice is implicit —
// the caller never picks a mode.
export type IntrospectResult = {
  ok: true;
  kind: "app";
  owner: string;
  repo: string;
  default_branch: string;
  branches: string[];
  suggested_app_name: string;
  dockerfiles: string[];
  detected_port: number | null;
  env_vars: Array<{ key: string; value: string }>;
  manifests: ParsedManifest[];
  notes: string[];
} | {
  ok: true;
  kind: "stack";
  owner: string;
  repo: string;
  default_branch: string;
  branches: string[];
  stack: StackPayload;
} | {
  ok: false;
  error: string;
  suggested_app_name?: string;
};


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

export async function introspectRepo(
  url: string,
  userId?: string,
  ref?: string,
  stackPath?: string,
): Promise<IntrospectResult> {
  let parsed: { owner: string; repo: string; ref?: string };
  try {
    parsed = parseGitHubRepo(url);
  } catch {
    return {
      ok: false,
      error: "We couldn't read that URL. Paste a GitHub repo link like https://github.com/owner/repo.",
    };
  }

  const { owner, repo, ref: urlRef } = parsed;
  const suggested_app_name = sanitizeAppName(repo);
  const token = await getGitHubPat(userId);
  // Prefer explicit ref param, then branch from URL, then repo default
  const requestedRef = ref || urlRef;

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
  // `default_branch` always reflects the repo's real default.
  // `fetchRef` is the branch we actually read files from (honors the caller's ref).
  const default_branch: string = repoData.default_branch || "main";
  const fetchRef: string = requestedRef || default_branch;

  // 2. Fetch the recursive git tree + branch list in parallel
  const notes: string[] = [];
  const [treeRes, branchesRes] = await Promise.all([
    ghFetch(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(fetchRef)}?recursive=1`,
      token,
    ),
    ghFetch(`/repos/${owner}/${repo}/branches?per_page=100`, token),
  ]);

  let branches: string[] = [];
  if (branchesRes.ok) {
    try {
      const list = (await branchesRes.json()) as Array<{ name: string }>;
      branches = list.map((b) => b.name);
      // Ensure the default branch is first
      branches.sort((a, b) =>
        a === default_branch ? -1 : b === default_branch ? 1 : a.localeCompare(b),
      );
    } catch {
      branches = [];
    }
  }
  if (branches.length === 0) branches = [default_branch];
  if (!treeRes.ok) {
    return {
      ok: true,
      kind: "app",
      owner,
      repo,
      default_branch,
      branches,
      suggested_app_name,
      dockerfiles: [],
      detected_port: null,
      env_vars: [],
      manifests: [],
      notes: ["We couldn't read the repo tree, so you'll need to fill in the rest manually."],
    };
  }
  const tree = await treeRes.json();
  const paths: string[] = (tree.tree || [])
    .filter((e: { type: string }) => e.type === "blob")
    .map((e: { path: string }) => e.path);
  if (tree.truncated) notes.push("Repo is large — some files may have been skipped.");

  // Stack detection is implicit: an `ocd-stack.json` (an explicit override path,
  // else the shallowest one in the tree) means this repo is a stack, so we
  // resolve it and hand back a stack-kind result instead of the single-app form.
  const detectedStackPath =
    stackPath && paths.includes(stackPath)
      ? stackPath
      : paths
          .filter((p) => /(^|\/)ocd-stack\.json$/.test(p))
          .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (detectedStackPath) {
    const resolved = await resolveStack(owner, repo, fetchRef, detectedStackPath, token);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, kind: "stack", owner, repo, default_branch, branches, stack: resolved.stack };
  }

  // 3. Discover .ocd-deploy.json manifests
  const manifestPaths = paths
    .filter((p) => /(^|\/)\.ocd-deploy\.json$/.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length); // shallowest first

  if (manifestPaths.length > 10) {
    notes.push(`Found ${manifestPaths.length} deploy manifests — only the first 10 will be loaded.`);
  }

  const manifests: ParsedManifest[] = [];
  const manifestContents = await Promise.all(
    manifestPaths.slice(0, 10).map((p) => fetchRawFile(owner, repo, fetchRef, p, token)),
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

  const envExampleCandidate = pickEnvExample(paths, dockerfiles[0] ?? null);

  // 4. Read the chosen files in parallel
  const [dockerfileContent, envContent] = await Promise.all([
    dockerfiles[0] ? fetchRawFile(owner, repo, fetchRef, dockerfiles[0], token) : Promise.resolve(null),
    envExampleCandidate ? fetchRawFile(owner, repo, fetchRef, envExampleCandidate, token) : Promise.resolve(null),
  ]);

  let detected_port: number | null = null;
  if (dockerfileContent) {
    detected_port = parseDockerfileExpose(dockerfileContent);
  }

  const env_vars = envContent ? parseEnvExample(envContent) : [];

  if (dockerfiles.length === 0) {
    notes.push("No Dockerfile found — add a Dockerfile to the repo root to deploy.");
  }

  return {
    ok: true,
    kind: "app",
    owner,
    repo,
    default_branch,
    branches,
    suggested_app_name,
    dockerfiles,
    detected_port,
    env_vars,
    manifests,
    notes,
  };
}

// --- Stack resolution -------------------------------------------------------
// Resolves an `ocd-stack.json` manifest and every per-app `.ocd-deploy.json` it
// references, all from a GitHub repo, so the web deploy page can build a stack
// without the local filesystem the CLI's `ocd stack up` reads from. Called by
// `introspectRepo` once the tree scan detects a stack manifest — the repo info
// and branch list are already fetched, so this only reads the manifests.

async function resolveStack(
  owner: string,
  repo: string,
  fetchRef: string,
  stackPath: string,
  token: string | null,
): Promise<{ ok: true; stack: StackPayload } | { ok: false; error: string }> {
  const stackRaw = await fetchRawFile(owner, repo, fetchRef, stackPath, token);
  if (!stackRaw)
    return { ok: false, error: `Could not read ${stackPath} on "${fetchRef}".` };

  let manifest: StackManifest;
  try {
    manifest = JSON.parse(stackRaw) as StackManifest;
  } catch {
    return { ok: false, error: `${stackPath} is not valid JSON.` };
  }
  if (!manifest.name || typeof manifest.name !== "string")
    return { ok: false, error: `${stackPath} is missing a "name".` };
  if (!manifest.apps || Object.keys(manifest.apps).length === 0)
    return { ok: false, error: `${stackPath} declares no apps.` };

  const stackDir = repoDirOf(stackPath);
  const notes: string[] = [];
  const repoUrl = `https://github.com/${owner}/${repo}`;

  const services: StackDeployRequest["services"] = Object.entries(manifest.services || {}).map(
    ([key, svc]) => ({
      key,
      type: svc.type,
      version: svc.version,
      volume_size: svc.volume_size,
      env_overrides: svc.env_overrides,
    }),
  );

  // Fetch every referenced app manifest in parallel, preserving key order.
  const appEntries = Object.entries(manifest.apps);
  const rawManifests = await Promise.all(
    appEntries.map(([, entry]) =>
      fetchRawFile(owner, repo, fetchRef, resolveRepoPath(stackDir, entry.manifest), token),
    ),
  );

  const apps: StackPayload["apps"] = [];
  for (let i = 0; i < appEntries.length; i++) {
    const [key, entry] = appEntries[i];
    const manifestPath = resolveRepoPath(stackDir, entry.manifest);
    const content = rawManifests[i];
    if (!content) {
      return { ok: false, error: `App "${key}" references ${manifestPath}, which we couldn't read on "${fetchRef}".` };
    }
    let appManifest: DeployManifest;
    try {
      const result = validateDeployManifest(JSON.parse(content));
      if (!result.ok) return { ok: false, error: `App "${key}" (${manifestPath}): ${result.error}` };
      appManifest = result.manifest;
    } catch {
      return { ok: false, error: `App "${key}" (${manifestPath}) is not valid JSON.` };
    }
    apps.push({
      manifest_path: manifestPath,
      env: appManifest.env ?? [],
      spec: buildStackAppSpec(key, entry, appManifest, repoUrl, repoDirOf(manifestPath)),
    });
  }

  // Validate dependency edges up front (mirrors the deploy_stack plan step).
  const appKeys = new Set(appEntries.map(([k]) => k));
  const serviceKeys = new Set(services.map((s) => s.key));
  for (const a of apps) {
    for (const n of a.spec.needs ?? []) {
      if (!appKeys.has(n) && !serviceKeys.has(n))
        return { ok: false, error: `App "${a.spec.key}" needs unknown key "${n}".` };
    }
  }

  return {
    ok: true,
    stack: {
      stack_path: stackPath,
      name: manifest.name,
      description: manifest.description,
      services,
      apps,
      notes,
    },
  };
}
