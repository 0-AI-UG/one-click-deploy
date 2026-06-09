const LLM_TXT = `# One-Click Deploy — .ocd-deploy.json Manifest

One-Click Deploy is a self-hosted platform that deploys Docker apps from GitHub repos to Hetzner Cloud servers. Repos can include \`.ocd-deploy.json\` manifest files to pre-configure the deploy flow so users just click "Deploy" without filling in any settings.

## File name

\`.ocd-deploy.json\`

Place it anywhere in your repo. For monorepos, add one per deployable service (e.g. \`services/api/.ocd-deploy.json\`, \`services/web/.ocd-deploy.json\`). All paths inside the manifest are relative to the directory containing the manifest file.

## Schema

\`\`\`json
{
  "$schema": 1,
  "$llm": "string — URL to the llm.txt that documents this manifest format (lets AI agents fetch the latest schema)",
  "name": "string (required) — display name shown in the deploy UI",
  "description": "string — short description shown when picking a service",
  "icon": "string — URL to a small logo/icon",

  "build": {
    "dockerfile": "string — path to Dockerfile, relative to this file's directory (default: Dockerfile)",
    "context": "string — Docker build context path, relative to the repo root (default: \".\" i.e. the repo root)",
    "container_port": "number — port the app listens on inside the container (1–65535)",
    "compose_file": "string — path to docker-compose/compose.yml, relative to this file's directory",
    "compose_web_service": "string — which compose service to route traffic to"
  },

  "env": [
    {
      "key": "string (required) — environment variable name, e.g. DATABASE_URL",
      "description": "string — explains what this variable is for (shown as hint in UI)",
      "default": "string — pre-filled value; omit for secrets the user must provide",
      "required": "boolean — if true, deploy is blocked until the user fills this in",
      "secret": "boolean — if true, the input field is masked in the UI"
    }
  ],

  "volume": {
    "size": "number — suggested persistent volume size in GB",
    "path": "string — mount path inside the container (must start with /)"
  },

  "webhook": {
    "enabled": "boolean — enable auto-deploy on git push",
    "branch": "string — branch to watch (default: repo's default branch)",
    "path": "string — only redeploy when files under this path prefix change",
    "wait_for_ci": "boolean — wait for CI checks to pass before deploying (default: false)"
  },

  "suggested_app_name": "string — suggested app name (DNS-safe: lowercase, digits, hyphens)",
  "replicas": "number — desired replica count (default: 1)",
  "public": "boolean — whether the app is publicly accessible (default: true)",
  "memory_mb": "number — per-container memory ceiling in MB (--memory/--memory-swap). Omit or 0 to use the platform default (512). Allowed: 0 or 128–32768. Dockerfile/railpack apps only (compose apps set limits in their compose file).",
  "userns": "boolean — allow the container to create unprivileged user/mount namespaces, needed for nested sandboxes like bubblewrap (runs --security-opt=seccomp=unconfined). Default false. Only enable if your app sandboxes untrusted code itself; it relaxes the host seccomp profile for this container.",
  "extra_volumes": [
    {
      "host_path": "string — absolute path on the host machine",
      "container_path": "string — absolute mount path inside the container"
    }
  ]
}
\`\`\`

All fields except \`name\` are optional. Unknown fields are ignored for forward compatibility.

## Rules

- \`$llm\` should point to the One-Click Deploy panel's \`/llm.txt\` endpoint so AI agents can fetch the latest manifest schema. Copy the URL from the examples below (it is auto-filled with the current panel's URL).
- \`$schema\` must be \`1\` (or omitted).
- Paths in \`build\` are relative to the manifest file's directory, except \`context\` which is relative to the repo root. A manifest at \`services/api/.ocd-deploy.json\` with \`"dockerfile": "Dockerfile"\` resolves to \`services/api/Dockerfile\`. If \`context\` is omitted, the build context defaults to \`"."\` (the repo root).
- Paths must not contain \`..\`.
- \`env[].key\` must match \`/^[A-Za-z_][A-Za-z0-9_]*$/\`. Reserved prefixes (\`DOCKER_\`, \`PATH\`, \`HOME\`, \`LD_\`, \`DYLD_\`) are blocked.
- A repo can have up to 10 manifest files. Extra manifests beyond 10 are ignored.

## Example: Single service

\`\`\`json
{
  "$schema": 1,
  "$llm": "{{PANEL_LLM_URL}}",
  "name": "My App",
  "description": "A Node.js web application",
  "build": {
    "dockerfile": "Dockerfile",
    "container_port": 3000
  },
  "env": [
    { "key": "DATABASE_URL", "description": "Postgres connection string", "required": true, "secret": true },
    { "key": "NODE_ENV", "default": "production" }
  ],
  "webhook": { "enabled": true, "branch": "main" },
  "suggested_app_name": "my-app"
}
\`\`\`

## Example: Compose-based app

\`\`\`json
{
  "$schema": 1,
  "$llm": "{{PANEL_LLM_URL}}",
  "name": "My Compose App",
  "description": "Multi-container app using Docker Compose",
  "build": {
    "compose_file": "docker-compose.yml",
    "compose_web_service": "server"
  },
  "env": [
    { "key": "API_KEY", "description": "External API key", "required": true, "secret": true },
    { "key": "LOG_LEVEL", "default": "info" }
  ],
  "volume": { "size": 10, "path": "/app/data" },
  "webhook": { "enabled": true, "branch": "main" },
  "suggested_app_name": "my-compose-app"
}
\`\`\`

## Example: Monorepo with two services

\`services/api/.ocd-deploy.json\`:
\`\`\`json
{
  "$schema": 1,
  "$llm": "{{PANEL_LLM_URL}}",
  "name": "API Server",
  "description": "REST API backend",
  "build": { "dockerfile": "Dockerfile", "context": ".", "container_port": 8080 },
  "env": [
    { "key": "DATABASE_URL", "required": true, "secret": true },
    { "key": "JWT_SECRET", "required": true, "secret": true }
  ],
  "volume": { "size": 10, "path": "/data" },
  "webhook": { "enabled": true, "branch": "main", "path": "services/api" },
  "suggested_app_name": "myapp-api"
}
\`\`\`

\`services/web/.ocd-deploy.json\`:
\`\`\`json
{
  "$schema": 1,
  "$llm": "{{PANEL_LLM_URL}}",
  "name": "Web Frontend",
  "description": "React SPA served by nginx",
  "build": { "dockerfile": "Dockerfile", "context": ".", "container_port": 80 },
  "env": [
    { "key": "API_URL", "description": "URL of the API server", "required": true }
  ],
  "webhook": { "enabled": true, "branch": "main", "path": "services/web" },
  "suggested_app_name": "myapp-web"
}
\`\`\`

## Guidelines for env vars

- Use \`required: true\` for variables that have no sensible default and must be provided by the deployer.
- Use \`secret: true\` for credentials, API keys, and connection strings — the UI will mask these inputs.
- Provide a \`default\` for non-sensitive configuration that works out of the box (e.g. \`NODE_ENV=production\`).
- Add a \`description\` to help the deployer understand what each variable is for.
`;

export function handleLlmTxt(request: Request): Response {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const panelLlmUrl = `${proto}://${host}/llm.txt`;
  const body = LLM_TXT.replaceAll("{{PANEL_LLM_URL}}", panelLlmUrl);
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
