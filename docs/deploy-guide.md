# Deploy Guide

## Prerequisites (Self-Hosted)

1. **Hetzner Cloud API token** — create one at [console.hetzner.cloud](https://console.hetzner.cloud) under your project's API tokens section.
2. **Hetzner DNS token** (optional) — needed only for custom domains. Create at [dns.hetzner.com/settings/api-token](https://dns.hetzner.com/settings/api-token).
3. **GitHub Personal Access Token** (optional) — needed for private repos and auto-redeploy webhooks. Create at GitHub Settings > Developer settings > Personal access tokens.

All tokens are stored in the macOS Keychain.

## Deploying an App

### 1. Configure Settings

On first launch, enter your Hetzner Cloud API token. Optionally configure:

- **DNS zone ID** — for custom domain support
- **Default server type** — e.g., `cpx12` (default), `cpx22`, `ccx13`
- **Default location** — e.g., `nbg1` (Nuremberg), `fsn1` (Falkenstein), `hel1` (Helsinki)

### 2. Fill Out the Deploy Form

| Field | Required | Description |
|-------|----------|-------------|
| App name | Yes | Lowercase letters, numbers, hyphens. 3-63 characters. |
| Git repo | Yes | HTTPS or SSH URL (e.g., `https://github.com/user/repo.git`) |
| Container port | Yes | The port your app listens on (1-65535) |
| Environment variables | No | Key-value pairs passed to the container |
| Custom domain | No | Your own domain (requires DNS token + zone ID) |
| Dockerfile path | No | Defaults to `Dockerfile` in repo root |
| Volume mount path | No | Persistent storage path inside the container |

### 3. Click Deploy

The deploy pipeline runs these steps:

1. **SRV** — Create or reuse a Hetzner server
2. **PRV** — Wait for server provisioning (cloud-init installs Docker + Caddy)
3. **DNS** — Create A record if custom domain specified
4. **VOL** — Create and attach Hetzner volume if requested
5. **BLD** — Clone repo and `docker build` on the server
6. **TLS** — Configure Caddy reverse proxy with automatic HTTPS
7. **CHK** — Health check (HTTP 200 on the container port)
8. **OK** — App is live

Each step streams progress back to the UI in real time.

### 4. Access Your App

Once deployed, the app is available at:
- `https://your-domain.com` (if custom domain configured)
- `http://<server-ip>` (direct IP access)

## Post-Deploy Operations

| Action | What it does |
|--------|-------------|
| **Redeploy** | Pulls latest code from git, rebuilds, and restarts |
| **Restart** | Restarts the container without rebuilding |
| **Rollback** | Restores a previous deployment's Docker image |
| **Update env vars** | Changes environment variables and restarts |
| **View logs** | Streams container stdout/stderr |
| **Enable webhook** | Auto-redeploys when you push to a branch |
| **Destroy** | Removes the container, DNS records, and optionally the server |

## Auto-Redeploy with Webhooks

1. Provide a GitHub PAT with `repo` and `admin:repo_hook` scopes
2. Deploy your app
3. Click "Enable Webhook" and choose a branch (default: `main`)
4. Every push to that branch triggers a rebuild and redeploy

## Persistent Storage

To persist data across redeploys (e.g., SQLite databases, uploads):

1. Set **Volume mount path** during deploy (e.g., `/data`)
2. A Hetzner Volume is created and attached to the server
3. The volume is mounted into the container at the specified path
4. Data survives container restarts, redeploys, and rollbacks
