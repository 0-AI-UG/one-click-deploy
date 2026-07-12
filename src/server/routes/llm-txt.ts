const LLM_TXT = `# One-Click Deploy (OCD)

One-Click Deploy ("OCD") is a self-hosted, open-source PaaS for Hetzner Cloud — a lightweight alternative to Heroku, Railway, and Render. Point it at a Git repo containing a Dockerfile and it provisions a Hetzner Cloud server, builds the container image, configures DNS, issues TLS (Traefik + Let's Encrypt), and serves traffic over HTTPS. It is deeply integrated with a single provider: Hetzner servers, volumes, private networks, firewalls, and Hetzner DNS.

This document covers the three things an AI agent most often needs: what the platform does, the \`.ocd-deploy.json\` manifest format, and the \`ocd\` CLI.

## Platform overview

- **Deploys**: any Git repo with a Dockerfile. The panel builds the image on a Hetzner server and runs it as one or more containers behind Traefik with automatic HTTPS.
- **Infrastructure**: servers, persistent volumes, private networks, and firewalls are provisioned automatically on Hetzner Cloud. DNS records can be managed via Hetzner DNS.
- **Scaling & lifecycle**: replicas (horizontal scaling), auto-scaling, restart, pause/unpause, rollback to a previous deployment, per-app memory limits.
- **Managed services**: one-click Postgres, Redis, MySQL, and more; their connection credentials are injected into linked environments.
- **Environments**: named groups of env vars (plain or secret) that can be shared across apps; changing an environment redeploys its linked apps.
- **Webhooks**: auto-deploy on git push, optionally scoped to a branch and path prefix, optionally waiting for CI checks to pass first.
- **Observability & access**: log streaming, a web terminal, and \`ocd ssh\` for running commands in app containers or on servers.
- **Auth**: passkeys, TOTP, GitHub OAuth, multi-user RBAC.

There are three ways to deploy an app:

1. **Web panel** — paste a GitHub repo URL. The panel introspects the repo (Dockerfiles, \`EXPOSE\` port, \`.env.example\` variables, and any \`.ocd-deploy.json\` manifests) and pre-fills the deploy form.
2. **\`.ocd-deploy.json\` manifest** — committed to the repo to pre-configure the deploy flow so users just click "Deploy" without filling in any settings. Documented below.
3. **\`ocd\` CLI** — deploy the current git checkout from the terminal. Documented at the end of this file.

# The .ocd-deploy.json manifest

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
    "container_port": "number — port the app listens on inside the container (1–65535)"
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
  "memory_mb": "number — per-container memory ceiling in MB (--memory/--memory-swap). Omit or 0 to use the platform default (512). Allowed: 0 or 128–32768.",
  "health_check": "boolean — set false for apps that don't speak HTTP on the exposed port (databases, queue workers); the platform then only verifies the container stays running (default: true)",
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
- Deployed apps are health-checked with an HTTP request to \`/\` on the exposed port; a deploy that never answers is rolled back. For non-HTTP apps (databases, queue workers) set \`"health_check": false\` so the platform only verifies the container stays running.

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

# The ocd CLI

\`ocd\` is a single-binary CLI (Linux, macOS, Windows) for driving a One-Click Deploy panel from the terminal.

## Install

\`\`\`bash
curl -fsSL {{PANEL_URL}}/cli/install.sh | sh
\`\`\`

The script detects OS/architecture, installs \`ocd\` to \`~/.local/bin\` (or \`/usr/local/bin\` as root), and pre-fills the panel URL. Binaries are also served directly from the panel at \`/cli/<binary>\` (\`ocd-linux-x64\`, \`ocd-linux-arm64\`, \`ocd-darwin-x64\`, \`ocd-darwin-arm64\`, \`ocd-windows-x64.exe\`).

## Authentication

\`\`\`bash
ocd login <panel-url>   # e.g. ocd login https://panel.example.com
\`\`\`

Login uses a browser device flow: the CLI prints a short code and opens the panel's authorization page; approve it there and the CLI stores a token in \`~/.config/ocd/config.json\` (or \`$XDG_CONFIG_HOME/ocd/config.json\`). Running \`ocd login\` with no argument reuses the saved panel URL.

## Commands

\`\`\`
ocd login <panel-url>        Log in to a panel (browser device flow)
ocd status                   Dashboard overview: apps and services with statuses
ocd apps                     List all apps (name, status, domain, repo)
ocd deploy [manifest]        Deploy the current git repo using .ocd-deploy.json
ocd redeploy <app>           Rebuild and redeploy an existing app
ocd logs <app> [--tail=N]    Show app logs (default: last 100 lines)
ocd restart <app>            Restart an app's containers
ocd rollback <app>           Roll back to the previous successful deployment
ocd pause <app>              Stop an app without deleting it
ocd unpause <app>            Start a paused app again
ocd envs <subcommand>        Manage environments and their variables
ocd services                 List managed services (Postgres, Redis, ...)
ocd servers                  List Hetzner servers and the apps on them
ocd ssh <app> <cmd>          Run a command inside an app container
ocd ssh <app> -i             Interactive shell inside an app container
ocd ssh <server> --server    Interactive shell on a server (disambiguates name collisions)
ocd version                  Print CLI version
\`\`\`

App and server arguments accept a name or numeric ID.

### ocd deploy

\`\`\`
ocd deploy [manifest] [--domain=<domain>] [--env=<name|id>] [--set=KEY=VALUE ...]
\`\`\`

Run from inside a git repo with an \`origin\` remote. Reads the manifest (default: \`./.ocd-deploy.json\`) for the app name, build settings, port, env vars, webhook, volume, and scaling configuration, then streams deploy progress step by step until it completes or fails. \`--domain\` sets a custom domain.

Env vars from the manifest's \`env[]\` section are included automatically: entries with a \`default\` are sent as-is, \`--set=KEY=VALUE\` (repeatable) overrides or adds values, and \`required\` vars still missing a value are prompted for interactively (hidden input when \`secret\`). In non-interactive shells, missing required vars fail the deploy with a message listing them — provide them via \`--set\`. Alternatively, \`--env\` links the app to an existing environment, which then supplies all variables (manifest env vars and \`--set\` are ignored).

### ocd envs

\`\`\`
ocd envs list                                                List all environments
ocd envs show <name|id>                                      Show details and variables
ocd envs create <name> [KEY=VALUE ...] [--secret KEY=VALUE]  Create an environment
ocd envs set <name|id> KEY=VALUE ... [--replace]             Merge (or replace) variables
ocd envs unset <name|id> KEY [KEY...]                        Remove variables
\`\`\`

\`--secret KEY=VALUE\` marks a variable as secret (encrypted at rest, not retrievable later). \`set\` and \`unset\` automatically redeploy the apps linked to the environment.
`;

export function handleLlmTxt(request: Request): Response {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const panelUrl = `${proto}://${host}`;
  const body = LLM_TXT
    .replaceAll("{{PANEL_LLM_URL}}", `${panelUrl}/llm.txt`)
    .replaceAll("{{PANEL_URL}}", panelUrl);
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
