const LLM_TXT = `# One-Click Deploy — .ocd-deploy.json Manifest

One-Click Deploy is a self-hosted platform that deploys Docker apps from GitHub repos to Hetzner Cloud servers. Repos can include \`.ocd-deploy.json\` manifest files to pre-configure the deploy flow so users just click "Deploy" without filling in any settings.

## File name

\`.ocd-deploy.json\`

Place it anywhere in your repo. For monorepos, add one per deployable service (e.g. \`services/api/.ocd-deploy.json\`, \`services/web/.ocd-deploy.json\`). All paths inside the manifest are relative to the directory containing the manifest file.

## Schema

\`\`\`json
{
  "$schema": 1,
  "name": "string (required) — display name shown in the deploy UI",
  "description": "string — short description shown when picking a service",
  "icon": "string — URL to a small logo/icon",

  "build": {
    "dockerfile": "string — path to Dockerfile, relative to this file's directory (default: Dockerfile)",
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
    "path": "string — only redeploy when files under this path prefix change"
  },

  "suggested_app_name": "string — suggested app name (DNS-safe: lowercase, digits, hyphens)",
  "replicas": "number — desired replica count (default: 1)"
}
\`\`\`

All fields except \`name\` are optional. Unknown fields are ignored for forward compatibility.

## Rules

- \`$schema\` must be \`1\` (or omitted).
- Paths in \`build\` are relative to the manifest file's directory. A manifest at \`services/api/.ocd-deploy.json\` with \`"dockerfile": "Dockerfile"\` resolves to \`services/api/Dockerfile\`.
- Paths must not contain \`..\`.
- \`env[].key\` must match \`/^[A-Za-z_][A-Za-z0-9_]*$/\`. Reserved prefixes (\`DOCKER_\`, \`PATH\`, \`HOME\`, \`LD_\`, \`DYLD_\`) are blocked.
- A repo can have up to 10 manifest files. Extra manifests beyond 10 are ignored.

## Example: Single service

\`\`\`json
{
  "$schema": 1,
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

## Example: Monorepo with two services

\`services/api/.ocd-deploy.json\`:
\`\`\`json
{
  "$schema": 1,
  "name": "API Server",
  "description": "REST API backend",
  "build": { "dockerfile": "Dockerfile", "container_port": 8080 },
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
  "name": "Web Frontend",
  "description": "React SPA served by nginx",
  "build": { "dockerfile": "Dockerfile", "container_port": 80 },
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

export function handleLlmTxt(): Response {
  return new Response(LLM_TXT, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
