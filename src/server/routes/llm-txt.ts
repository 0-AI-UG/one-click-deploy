const LLM_TXT = `# One-Click Deploy (OCD)

One-Click Deploy ("OCD") is a self-hosted, open-source PaaS for Hetzner Cloud, a lightweight alternative to Heroku, Railway, and Render. Point it at a Git repo containing a Dockerfile and it provisions a Hetzner Cloud server, builds the container image, configures DNS, issues TLS (Traefik + Let's Encrypt), and serves traffic over HTTPS. It is deeply integrated with a single provider: Hetzner servers, volumes, private networks, firewalls, and Hetzner DNS.

This document covers the three things an AI agent most often needs: what the platform does, the \`.ocd-deploy.json\` manifest format, and the \`ocd\` CLI.

## Platform overview

- **Deploys**: any Git repo with a Dockerfile. The panel builds the image on a Hetzner server and runs it as one or more containers behind Traefik with automatic HTTPS.
- **Infrastructure**: servers, persistent volumes, private networks, and firewalls are provisioned automatically on Hetzner Cloud. DNS records can be managed via Hetzner DNS.
- **Scaling & lifecycle**: replicas (horizontal scaling), auto-scaling, restart, pause/unpause, rollback to a previous deployment, per-app memory & CPU limits.
- **Managed services**: one-click Postgres, Redis, MySQL, and more; their connection credentials are injected into linked environments.
- **Environments**: named groups of env vars (plain or secret) that can be shared across apps; changing an environment redeploys its linked apps.
- **Internal networking**: every app has a stable private address \`<app>.ocd.internal:<internal-port>\` reachable from other apps on the private network (private apps have only this address). The internal routing protocol is set by \`internal_protocol\` (\`"http"\` L7 routing, or \`"tcp"\` raw pass-through; defaults to \`"http"\`). The platform injects \`OCD_INTERNAL_URL\` (\`http://<app>.ocd.internal:<port>\` for HTTP-routed apps, \`tcp://\` for TCP-routed ones), \`OCD_INTERNAL_HOST\`, and \`OCD_INTERNAL_PORT\` into every app container; a user-defined env var with the same key takes precedence.
- **Webhooks**: auto-deploy on git push, optionally scoped to a branch and path prefix, optionally waiting for CI checks to pass first.
- **Observability & access**: log streaming, a web terminal, and \`ocd ssh\` for running commands in app containers or on servers.
- **Auth**: passkeys, TOTP, GitHub OAuth, multi-user RBAC.

There are three ways to deploy an app:

1. **Web panel**: paste a GitHub repo URL. The panel introspects the repo (Dockerfiles, \`EXPOSE\` port, \`.env.example\` variables, and any \`.ocd-deploy.json\` manifests) and pre-fills the deploy form.
2. **\`.ocd-deploy.json\` manifest**: committed to the repo to pre-configure the deploy flow so users just click "Deploy" without filling in any settings. Documented below.
3. **\`ocd\` CLI**: deploy the current git checkout from the terminal. Documented at the end of this file.

To deploy **several apps and managed services together** as one ordered, health-gated unit, use a **stack** (an \`ocd-stack.json\` manifest) — via \`ocd stack up\` or the web panel's Deploy → Stack tab. See "The ocd-stack.json manifest" below.

# The .ocd-deploy.json manifest

## File name

\`.ocd-deploy.json\`

Place it anywhere in your repo. For monorepos, add one per deployable service (e.g. \`services/api/.ocd-deploy.json\`, \`services/web/.ocd-deploy.json\`). All paths inside the manifest are relative to the directory containing the manifest file.

## Schema

\`\`\`json
{
  "$schema": 1,
  "$llm": "string: URL to the llm.txt that documents this manifest format (lets AI agents fetch the latest schema)",
  "name": "string (required): display name shown in the deploy UI",
  "description": "string: short description shown when picking a service",
  "icon": "string: URL to a small logo/icon",

  "build": {
    "dockerfile": "string: path to Dockerfile, relative to this file's directory (default: Dockerfile)",
    "context": "string: Docker build context path, relative to the repo root (default: \".\" i.e. the repo root)",
    "container_port": "number: port the app listens on inside the container (1–65535)"
  },

  "env": [
    {
      "key": "string (required): environment variable name, e.g. DATABASE_URL",
      "description": "string: explains what this variable is for (shown as hint in UI)",
      "default": "string: pre-filled value; omit for secrets the user must provide",
      "required": "boolean: if true, deploy is blocked until the user fills this in",
      "secret": "boolean: if true, the input field is masked in the UI"
    }
  ],

  "volume": {
    "size": "number: suggested persistent volume size in GB",
    "path": "string: mount path inside the container (must start with /)"
  },

  "webhook": {
    "enabled": "boolean: enable auto-deploy on git push",
    "branch": "string: branch to watch (default: repo's default branch)",
    "path": "string: only redeploy when files under this path prefix change",
    "wait_for_ci": "boolean: wait for CI checks to pass before deploying (default: false)"
  },

  "suggested_app_name": "string: suggested app name (DNS-safe: lowercase, digits, hyphens)",
  "replicas": "number: desired replica count (default: 1)",
  "public": "boolean: whether the app is publicly accessible (default: true)",
  "memory_mb": "number: per-container memory ceiling in MB (--memory/--memory-swap). Omit or 0 to use the platform default (512). Allowed: 0 or 128–32768.",
  "cpu_limit": "number: per-container CPU ceiling in cores (--cpus), fractional allowed. Omit or 0 to use the platform default (1). Allowed: 0 or 0.1–32.",
  "health_check": {
    "enabled": "boolean. Set false for apps that don't speak HTTP on the exposed port (databases, queue workers); the platform then only verifies the container stays running (default: true)",
    "path": "string. Endpoint the post-deploy probe and Traefik's rotation check both request, e.g. \"/healthz\" (default: \"/\"). Setting a path also enables Traefik's continuous check, which drops failing replicas from rotation. Requires internal_protocol \"http\""
  },
  "internal_protocol": "string. Internal routing protocol: \"http\" (L7 routing) or \"tcp\" (raw pass-through). Defaults to \"http\". Password protection, sticky sessions and health_check.path require \"http\".",
  "sticky": "boolean. Cookie-based sticky sessions on the app's ingress service; requires internal_protocol \"http\" (default: false)",
  "rate_limit_rps": "number. Public-domain rate limit in requests/sec per client IP; 0 = unlimited (default: 0)",
  "ip_allowlist": "string. Comma-separated IPs/CIDRs allowed to reach the public domain, e.g. \"203.0.113.4, 10.0.0.0/8\"; empty = open to all",
  "compress": "boolean. gzip responses on the public domain (default: false)",
  "public_port": "number | \"auto\". Expose a raw public TCP/UDP port on the panel IP (game servers, databases, MQTT); \"auto\" picks the lowest free pool port. Independent of the public HTTP domain. Omit for no raw exposure",
  "public_protocol": "string. Pool for public_port: \"tcp\" (30000-30049) or \"udp\" (30050-30099); default \"tcp\"",
  "extra_volumes": [
    {
      "host_path": "string: absolute path on the host machine",
      "container_path": "string: absolute mount path inside the container"
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
- Deployed apps are health-checked with an HTTP request to \`health_check.path\` (default \`/\`) on the exposed port; a deploy that never answers is rolled back. For non-HTTP apps (databases, queue workers) set \`"health_check": { "enabled": false }\` so the platform only verifies the container stays running.

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
- Use \`secret: true\` for credentials, API keys, and connection strings; the UI will mask these inputs.
- Provide a \`default\` for non-sensitive configuration that works out of the box (e.g. \`NODE_ENV=production\`).
- Add a \`description\` to help the deployer understand what each variable is for.

# The ocd-stack.json manifest (multi-app stacks)

A **stack** deploys several apps and managed services together from one compose-style manifest, with dependency ordering and credential/URL wiring handled for you. Deploy a stack from the CLI (\`ocd stack up\`) or the web panel (Deploy → Stack tab: paste the repo, tweak any option, deploy).

## File name

\`ocd-stack.json\`, conventionally at the repo root. It **references** each app's own \`.ocd-deploy.json\` by path — it does not inline per-app build/env config.

## Schema

- \`name\` (string, required) — stack name. Every member is named \`<name>-<key>\` and is fleet-globally unique (e.g. stack \`blog\` + app key \`web\` → app \`blog-web\`).
- \`description\` (string, optional).
- \`services\` (object, optional) — map of service key → managed service:
  - \`type\` (string, required) — catalog type: \`postgres\`, \`redis\`, \`mysql\`, ...
  - \`version\` (string), \`volume_size\` (number, GB), \`env_overrides\` (object) — all optional.
- \`apps\` (object, required) — map of app key → app:
  - \`manifest\` (string, required) — path to that app's \`.ocd-deploy.json\`, relative to \`ocd-stack.json\`.
  - \`needs\` (string[], optional) — keys of services/apps this app depends on.
  - \`domain\` (string), \`public\` (boolean) — optional overrides of the app manifest.

## Semantics

- **Ordering + readiness**: \`needs\` forms a dependency graph. Services deploy first, then apps in dependency order — an app only starts once everything it needs is deployed **and healthy** (deploys are health-gated). Dependency cycles are rejected.
- **Wiring**: a stack owns one shared environment — auto-created, or an existing one reused via \`--env\` / the web panel's env picker (only when the stack is first created). Every member's own \`env[]\` vars are merged into it (see the env-merge rules under \`ocd stack up\`), services inject their credentials into it, and each app publishes its private internal URL as \`<KEY>_URL\` (the uppercased app key), so a dependent reaches a sibling without knowing its real name or DNS. An app with \`needs: ["api"]\` sees an \`API_URL\` env var.
- **Reconcile**: \`ocd stack up\` redeploys every app in the manifest, and separately destroys members recorded under the stack but no longer listed.
- **Atomic**: if any member fails, the whole run rolls back — members deployed in that run are destroyed.
- **Capacity**: the fleet has a hard 200-app cap; a stack that would exceed it is rejected before anything deploys.

## Example: ocd-stack.json

\`\`\`json
{
  "$schema": 1,
  "name": "blog",
  "description": "API + web frontend on Postgres",
  "services": {
    "db": { "type": "postgres", "version": "16", "volume_size": 10 }
  },
  "apps": {
    "api": { "manifest": "services/api/.ocd-deploy.json", "needs": ["db"] },
    "web": { "manifest": "services/web/.ocd-deploy.json", "needs": ["api"], "public": true }
  }
}
\`\`\`

Pairs with the two \`.ocd-deploy.json\` files from the monorepo example above: \`api\` receives the Postgres credentials from the \`db\` service (via the stack environment), and \`web\` receives \`API_URL\` pointing at \`api\`. Because \`web\` needs \`api\` and \`api\` needs \`db\`, they deploy in the order db → api → web, each waiting for the previous to become healthy.

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
ocd stack <up|down|ls|status|logs>  Deploy/manage multi-app stacks (ocd-stack.json)
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

Env vars from the manifest's \`env[]\` section are included automatically: entries with a \`default\` are sent as-is, \`--set=KEY=VALUE\` (repeatable) overrides or adds values, and \`required\` vars still missing a value are prompted for interactively (hidden input when \`secret\`). In non-interactive shells, missing required vars fail the deploy with a message listing them; provide them via \`--set\`. \`--env\` links the app to an existing environment: the manifest's env vars are then **layered on top** of it — a value already present in the environment wins (the manifest default is skipped), keys the environment lacks are added, and \`--set\` overrides everything.

### ocd stack

\`\`\`
ocd stack up [manifest] [--env=<name|id>] [--set=<app>.KEY=VALUE ...]   Deploy a stack (default manifest: ocd-stack.json)
ocd stack down <name> [--yes]                         Destroy a stack and every member
ocd stack ls                                           List stacks
ocd stack status <name>                                Show a stack's apps and services
ocd stack logs <name>                                  Print a stack's combined deploy log
\`\`\`

\`ocd stack up\` reads \`ocd-stack.json\` and each referenced \`.ocd-deploy.json\`, then deploys the whole stack in dependency order and streams progress. Run it from inside the git repo whose \`origin\` remote holds the apps. Re-running it reconciles: apps in the manifest are redeployed, members dropped from the manifest are destroyed. See "The ocd-stack.json manifest" above for the format and wiring semantics.

Because every member shares one environment, env vars from all the apps' \`env[]\` sections are **merged into that single shared environment** rather than collected per app:

- Where only one app declares a key (or only one supplies a non-empty default), that value is used.
- Where several apps declare the same key with **different** defaults, the deploy is refused — unless a \`--set\` or an existing env var resolves it.
- \`--set=KEY=VALUE\` (and \`--set=<app>.KEY=VALUE\`, which also targets the shared key) overrides everything; \`--env=<name|id>\` reuses an existing environment whose values win over manifest defaults (\`--set\` still overrides). Precedence: \`--set\` > existing env var > manifest default.
- \`required\` vars still missing a value after merging are prompted for once.

\`--env\` is only honored when the stack is first created; on later re-ups the stack keeps the environment it already owns.

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
