# Networking and ingress

## Contents

- [Network layers](#network-layers)
- [Private app addressing](#private-app-addressing)
- [Managed-service addressing](#managed-service-addressing)
- [Public HTTP routing](#public-http-routing)
- [Internal protocol](#internal-protocol)
- [Health checks](#health-checks)
- [HTTP middleware](#http-middleware)
- [Raw public TCP and UDP](#raw-public-tcp-and-udp)
- [Configuration timing](#configuration-timing)

## Network layers

OCD provides three distinct exposure mechanisms:

1. stable private app/service names on the fleet network;
2. public HTTP/HTTPS domain routing through panel ingress;
3. optional raw TCP/UDP ports on the panel IP.

`public: false` only disables public-domain routing. Private app networking and
explicit raw public port exposure are separate.

## Private app addressing

Every app receives a fleet-unique virtual IP and stable name:

```text
<app>.ocd.internal
```

OCD keeps `/etc/hosts` and the per-host proxy reconciled across ready servers.
The platform injects:

- `OCD_INTERNAL_URL`
- `OCD_INTERNAL_HOST`
- `OCD_INTERNAL_PORT`

For HTTP-routed apps:

```text
OCD_INTERNAL_URL=http://<app>.ocd.internal
OCD_INTERNAL_HOST=<app>.ocd.internal
OCD_INTERNAL_PORT=80
```

For raw-TCP apps:

```text
OCD_INTERNAL_URL=tcp://<app>.ocd.internal:<container_port>
OCD_INTERNAL_HOST=<app>.ocd.internal
OCD_INTERNAL_PORT=<container_port>
```

A user-defined environment key with the same name wins.

Stack app key `api` publishes its `OCD_INTERNAL_URL` into the stack environment
as `API_URL`.

## Managed-service addressing

Managed services use:

```text
<service-name>.svc.ocd.internal
```

This resolves to the service host's private IP. The catalog generates the
correct scheme/port and connection URL. Consume injected `<KEY>_URL` values
instead of reconstructing service URLs.

## Public HTTP routing

With `public: true`, an app receives either:

- its explicitly configured domain;
- an auto-domain from the configured DNS zone;
- a fallback address when no managed zone is resolvable.

OCD manages routing and, where configured, DNS records. Custom domain and
auto-domain routing use the app's HTTP service over the private network.

Setting `public: false` removes public routing while retaining private access.
An existing domain may remain stored so public access can be re-enabled, but no
public router should serve the private app.

## Internal protocol

`internal_protocol` selects private ingress behavior:

- `http` (default): L7 HTTP routing, portless internal URL, middleware and HTTP
  health checks available;
- `tcp`: raw pass-through to `container_port`, no HTTP middleware/request
  metrics.

Do not set `tcp` merely because a worker has no public endpoint. Set it only
when consumers connect with a raw-TCP protocol. A worker with no listener may
remain HTTP-routed but should disable HTTP health checking, or expose an
appropriate health endpoint.

## Health checks

`health_check.enabled: true` performs a post-deploy HTTP probe. The default path
is `/`. Failure rolls the deployment back.

Setting `health_check.path`:

- requires an absolute, whitespace-free path;
- is valid only for HTTP routing;
- configures the deployment probe;
- enables continuous Traefik health checks so unhealthy replicas leave
  rotation.

`health_check.enabled: false` skips the HTTP response probe but still checks
that the container remains running.

## HTTP middleware

HTTP-routed public apps support:

- basic auth;
- cookie stickiness;
- per-client rate limiting;
- IPv4/IPv6/CIDR allowlists;
- gzip compression;
- active health-check path.

Rules:

- basic auth, stickiness, and health paths are invalid for raw TCP;
- rate limit must be `0..1000000`, where zero disables it;
- allowlist entries must be valid IPs or CIDRs, with IPv4 prefix `0..32` and
  IPv6 prefix `0..128`;
- an empty allowlist means open access;
- never commit the basic-auth plaintext password.

## Raw public TCP and UDP

`public_port` exposes an app directly on the panel IP, independently of its HTTP
domain:

- TCP pool: `30000..30049`;
- UDP pool: `30050..30099`;
- `"auto"`: choose the lowest available port in the selected pool;
- integer: request that exact free port;
- `null`: remove exposure.

`public_protocol` defaults to `tcp`. Port uniqueness is fleet-wide.

Raw exposure can coexist with `public: false`. This is useful for games, MQTT,
databases, and other non-HTTP protocols, but it is internet exposure and should
be treated as security-sensitive.

## Configuration timing

Ingress-only manifest applications are rendered immediately. Container-injected
values such as `OCD_INTERNAL_URL` update only when a container is recreated.

Examples:

- changing an allowlist or compression can take effect without a build;
- changing `internal_protocol` resyncs ingress, but recreate the container so
  its `OCD_INTERNAL_*` values match;
- changing `container_port`, environment, memory, CPU, or build settings needs
  a rollout to affect running containers.
