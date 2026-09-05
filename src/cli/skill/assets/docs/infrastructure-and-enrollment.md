# Infrastructure and Server Enrollment

OCD can run without cloud-provider credentials. Hetzner is an optional
infrastructure provisioner, not an account or runtime requirement.

## Server ownership

- A **managed Hetzner** server is created and owned by OCD. It supports OCD
  provider volumes, network/firewall reconciliation, and
  provider-side deletion.
- A **connected** server is owned by the operator. OCD runs app containers and
  can create persistent server-local directories there, but never deletes the
  VPS or attaches provider volumes. Removing it from OCD only disconnects its
  database record and is refused while local volumes remain tracked.

Direct SSH remains available. OCD's enrollment key is the platform key used
for orchestration; it does not replace or remove operator-owned SSH keys.

## Connect an existing VPS

The current enrollment contract is deliberately narrow: Linux with Docker, an
IPv4 management address, a routing IPv4 address reachable from the panel, and
root SSH on port 22.

1. Print OCD's public key and add it to `/root/.ssh/authorized_keys` on the VPS:

   ```bash
   ocd servers enrollment-key
   ```

2. Obtain the VPS's Ed25519 host-key line:

   ```bash
   ssh-keyscan -t ed25519 203.0.113.10
   ```

   Verify its fingerprint through a trusted provider console or an existing
   trusted SSH session. Do not treat `ssh-keyscan` itself as verification.

3. Enroll the server:

   ```bash
   ocd servers connect \
     --name=app-1 \
     --address=203.0.113.10 \
     --routing-address=10.0.0.11 \
     --host-key='203.0.113.10 ssh-ed25519 AAAA...'
   ```

OCD pins the supplied host key, verifies key-based SSH and Docker, confirms the
host owns the claimed routing address, and proves the panel can reach the same
verified host through that address. Enrollment fails closed if any
check fails.

Inspect ownership with `ocd servers` or `ocd servers show <name|id>`. Use
`ocd servers delete <name|id>` to destroy a managed host or disconnect a
connected host; both remain browser-confirmed operations.

## Optional Hetzner provisioning

An administrator may add a Hetzner Cloud API token in the panel's
**Optional Infrastructure Provider** settings. Until then, provider server
types are empty and requests that need new managed capacity fail with guidance
to configure Hetzner or connect an existing host.

DNS stays operator-owned regardless of infrastructure provider. Configure an
optional default domain suffix, then create the A/AAAA records OCD displays at
the DNS provider of your choice.

## Dedicated build capacity

An empty managed or connected server can be reserved as an OCD BuildKit
worker. OCD excludes it from app placement and prevents
deletion until the worker is removed. See [Build workers and
webhooks](build-workers-and-webhooks.md) for the trust boundary and commands.
