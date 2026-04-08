# RPC Reference

All RPC methods are defined in `src/shared/rpc.ts` and implemented in `src/bun/index.ts`.

## Read Methods

### `getServers()`
Returns all tracked servers with their deployed apps.

**Returns:** `ServerWithApps[]` — each server includes its list of apps.

### `getApps()`
Returns all deployed apps across all servers.

**Returns:** `App[]`

### `getSettings()`
Returns current settings (DNS zone ID, default server type, default location).

**Returns:** `Settings`

### `getContainerLogs(app_id: string, tail?: number)`
Fetches container stdout/stderr from the remote server.

**Parameters:**
- `app_id` — the app to fetch logs for
- `tail` — number of recent lines (optional)

**Returns:** `string` — raw log output

### `getDeployments(app_id: string)`
Returns deployment history for an app.

**Returns:** `Deployment[]` — ordered by creation date, includes image tag, git commit, status

### `getDeployLog(app_id: string)`
Returns the full deploy log for the most recent deployment.

**Returns:** `string`

## Write Methods

### `saveSettings(settings: Settings)`
Persists settings to the database. Tokens are stored encrypted in the `encrypted_secrets` table.

### `deploy(request: DeployRequest)`
Triggers a full deploy pipeline. Streams progress via callback.

**Parameters (DeployRequest):**
- `app_name` — unique name for the app
- `git_repo` — repository URL
- `container_port` — port the app listens on
- `env_vars` — environment variables (optional)
- `domain` — custom domain (optional)
- `dockerfile_path` — path to Dockerfile (optional, default: `Dockerfile`)
- `server_id` — deploy to existing server (optional, creates new if omitted)
- `server_type` — Hetzner server type (optional, uses default)
- `location` — Hetzner datacenter (optional, uses default)
- `volume_mount` — persistent volume mount path (optional)

**Progress callback:** Called with `{ step, status, message }` at each pipeline stage.

### `redeployApp(app_id: string)`
Pulls latest code from git, rebuilds the Docker image, and restarts the container.

### `restartApp(app_id: string)`
Restarts the container without rebuilding.

### `rollbackApp(app_id: string, deployment_id: string)`
Restores a previous deployment by re-running its Docker image.

### `updateAppEnv(app_id: string, env_vars: Record<string, string>)`
Updates environment variables and restarts the container.

### `destroyApp(app_id: string)`
Stops and removes the container, cleans up DNS records and volumes.

### `deleteServer(server_id: string)`
Deletes the Hetzner server and all apps on it.

### `enableWebhook(app_id: string, branch?: string)`
Creates a GitHub webhook for auto-redeploy on push. Defaults to `main` branch.

### `disableWebhook(app_id: string)`
Removes the GitHub webhook.

## Deploy Progress Steps

During `deploy()`, progress is reported with these step keys:

| Step | Description |
|------|-------------|
| `SRV` | Creating or selecting server |
| `PRV` | Waiting for server provisioning |
| `DNS` | Creating DNS records |
| `VOL` | Creating and attaching volume |
| `BLD` | Cloning repo and building Docker image |
| `TLS` | Configuring Caddy reverse proxy |
| `CHK` | Running health check |
| `OK` | Deploy complete |

Each step reports `status`: `pending`, `running`, `done`, or `error`.
