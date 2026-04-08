# One-Click Deploy

One-Click Deploy is a self-hosted web panel that makes deploying containerized apps trivial. It removes the need to understand cloud infrastructure — provide a Git repo with a Dockerfile, and the panel handles everything from server provisioning to TLS certificates.

You run the panel yourself (as a Docker container) and connect it to your Hetzner Cloud account. The panel provisions servers, builds containers, configures DNS, and manages deployments directly against your account. You own the infrastructure and pay Hetzner directly.

The panel can also deploy and manage itself — see the "Deploy this panel" preset on the deploy page.

## What Can Be Deployed

Any application that meets these requirements:

- Has a **Git repository** (public, or private with a GitHub PAT)
- Contains a **Dockerfile**
- Listens on a **TCP port**

Common examples: Node.js APIs, Python Flask/FastAPI apps, Go services, static sites with nginx, any Docker-compatible workload.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Tailwind CSS |
| Backend | Bun, native SQLite |
| Packaging | Docker image (multi-arch) |
| Infrastructure | Hetzner Cloud (servers, DNS, volumes) |
| Reverse proxy | Caddy (automatic TLS) |
| Containers | Docker |
