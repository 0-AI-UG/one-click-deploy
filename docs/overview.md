# One-Click Deploy

One-Click Deploy is a desktop application that makes deploying containerized apps trivial. It removes the need to understand cloud infrastructure — provide a Git repo with a Dockerfile, and the app handles everything from server provisioning to TLS certificates.

## Two Modes

### Self-Hosted Mode (available now)

You bring your own Hetzner Cloud account. The app provisions servers, builds containers, configures DNS, and manages deployments directly against your Hetzner account. You own the infrastructure and pay Hetzner directly.

### Managed Mode (coming soon)

Sign in with GitHub and deploy to shared infrastructure we manage. Free tier includes 1 app with 256MB RAM. No cloud account needed.

## What Can Be Deployed

Any application that meets these requirements:

- Has a **Git repository** (public, or private with a GitHub PAT)
- Contains a **Dockerfile**
- Listens on a **TCP port**

Common examples: Node.js APIs, Python Flask/FastAPI apps, Go services, static sites with nginx, any Docker-compatible workload.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electrobun |
| Frontend | React 19, Tailwind CSS |
| Backend | Bun, native SQLite |
| IPC | BrowserView.defineRPC |
| Infrastructure | Hetzner Cloud (servers, DNS, volumes) |
| Reverse proxy | Caddy (automatic TLS) |
| Containers | Docker (gVisor in managed mode) |
