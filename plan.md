# Plan: Drop Hetzner LB, use Caddy + a private network

## Goal

Replace the Hetzner Cloud Load Balancer with Caddy reverse-proxy on the
panel server, and put every server on a single shared Hetzner private
network. The Hetzner LB only really gave us ingress HA — and the panel
server is already a SPOF, so paying €5/mo per scaled app for HA in
front of a non-HA control plane never made sense. As a bonus, dropping
the LB removes the entire bug surface we just spent the day in
(cert idempotency, source-IP gotchas, port-pinning, DNS swap).

## Architecture after this change

- **One private network** (`ocd-net`, e.g. `10.0.0.0/16`). Every
  server is attached at create time. Each server's private IPv4 is
  persisted in `servers.private_ipv4`.
- **One ingress Caddy** on the panel server (already exists for
  non-scaled apps today). It owns:
  - Public DNS for every custom-domain app (`<domain>` → panel server
    public IPv4).
  - TLS termination via Let's Encrypt (already in place for solo apps;
    extend to scaled apps).
  - Reverse-proxy to backends via **private IPs**:
    - 1-replica app → 1 upstream (the replica's private IP:port).
    - N-replica app → N upstreams, round_robin (or `ip_hash` for
      sticky), with health checks.
- **App-to-app** uses the same Caddy. Each app gets a stable internal
  hostname `<app>.ocd.internal` that resolves to a Caddy vhost on the
  panel server's private IP, which proxies to the same backend pool.
  Callers always use the internal hostname; the URL never changes when
  the app scales up/down.
- **No Hetzner LB. No managed certificates. No `addLBRule` /
  `addLBTarget` / `addLBService` plumbing.**

## What gets built

1. **Private network** — `ensureNetwork()` mirroring `ensureFirewall()`.
   Persist `network_id` in settings, server private IP per row.
2. **Server provisioning** — pass `networks: [networkId]` in
   `POST /servers`; capture private IPv4 from the response.
3. **Server-to-network reconciler pass** — for any server not yet
   attached, call `attach_to_network` (no reboot). Backfill
   `private_ipv4`. Required before step 5 ships.
4. **Caddy upstream manager** — small module that, given an app id,
   computes the desired Caddy site config (public vhost + internal
   vhost, upstream list = current replicas' private IPs) and
   PUTs it to Caddy admin API. Reloads are atomic.
5. **Wire it into the lifecycle**:
   - Deploy: after replica health-check, write Caddy site → reload.
   - Scale up: provision new server (already in private net), run
     container, append upstream → reload. **No LB calls at all.**
   - Scale down: stop container, remove upstream → reload.
   - Redeploy: rolling — add new replica, remove old upstream, etc.
6. **Internal DNS resolution** — two options, pick one:
   - **(a) /etc/hosts on every server.** Reconciler keeps
     `<app>.ocd.internal → panel-server-private-ip` in sync. Simple,
     no extra daemon, works for every container via Docker's
     host-to-IP propagation.
   - **(b) CoreDNS or dnsmasq** on the panel server, every other
     server's `/etc/resolv.conf` points there first. More flexible
     long-term but more moving parts. **Default to (a) until we have
     a reason to upgrade.**
7. **Migration of existing scaled apps off Hetzner LB**:
   - For every app with `lb_provider_id`: write the new Caddy config
     pointing at the same replicas' private IPs, reload Caddy, swing
     the public DNS record from LB IP → panel server IP, then delete
     the Hetzner LB and clear `lb_provider_id`.
   - Run as a one-shot migration on first boot of the new code, gated
     on a `migrations.applied` flag.

## What gets deleted

- `src/bun/hetzner/load-balancers.ts` — entire file.
- `src/bun/hetzner/servers.ts` `addLBFirewallRule` /
  `removeLBFirewallRule` and the `firewallRules` provider section.
- `src/bun/scale/scale-up.ts` LB block (lines ~32–133): create LB,
  cert, addService, DNS swap, addTarget, addLBRule, removeCaddySite.
- `src/bun/scale/scale-down.ts` LB teardown branch.
- `src/bun/scale/scale-up.ts` `rebindContainer` call — containers can
  stay on `127.0.0.1:hostPort` since Caddy reaches them via the
  Docker bridge on the host, no need to flip to `0.0.0.0`. (Caddy
  proxies `host-private-ip:hostPort` → forwarded by host to
  `127.0.0.1:hostPort` → container.) Wait — actually no: the host's
  private NIC will only route to a port published on `0.0.0.0` (or
  the private IP specifically). Decide during implementation: either
  bind containers to `0.0.0.0:hostPort` like the LB path does today,
  or `<private_ipv4>:hostPort`. The latter is tighter and is the
  preferred default.
- `lb_provider_id` column on apps: keep for now, drop in a follow-up
  migration after the one-shot migration above has run everywhere.

## Tradeoffs / what we give up

- **Ingress HA.** If the panel server dies, all sites are down. Status
  quo: panel server dying already kills the panel, the reconciler,
  scaling, and any unscaled app. So the *effective* availability of
  the system doesn't change — we're just being honest about the SPOF
  instead of papering over part of it with a €5/mo LB.
- **Hetzner-managed TLS.** Let's Encrypt via Caddy is a known-good
  replacement and is what solo apps already use. No regression.
- **Future ingress-HA option.** If/when someone wants real HA: keep a
  Hetzner LB *only* in front of the ingress Caddy(s), with multiple
  Caddy ingress servers running identical config. This becomes a
  tier-up feature, not the default path. Out of scope for this plan.

## Migration ordering (single rollout, two reconciler ticks apart)

1. Ship "private network + server attachment + private_ipv4 backfill"
   code. Reconciler tick attaches every existing server. Caddy still
   talks to public IPs (no behavior change yet).
2. Once all servers report a `private_ipv4`, ship the Caddy
   upstream manager + the LB-removal one-shot migration. On boot:
   - For each app with `lb_provider_id`: write new Caddy config →
     reload → swing DNS → delete LB.
   - For each unscaled app: optional, also rewrite via the new
     manager so all apps use the same code path.
3. Follow-up PR: delete `load-balancers.ts`, `lb_provider_id` column,
   firewall LB rule plumbing, and the LB UI.

## Out of scope

- Multi-region.
- Real ingress HA (multiple Caddy ingress servers + Hetzner LB
  in front of them).
- Replacing the Docker `--network ocd-net` bridge — that's intra-host
  container linking, orthogonal to the cloud private net.
