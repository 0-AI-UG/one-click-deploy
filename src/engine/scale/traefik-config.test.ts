import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  collectDesiredState,
  publicTls,
  renderDynamicConfig,
  renderPanelConfig,
} from "./traefik-render.ts";
import {
  traefikInstallScript,
  traefikStaticConfig,
  traefikSystemdUnit,
} from "./traefik-provision.ts";
import {
  BASIC_AUTH_USER,
  TRAEFIK_ACCESS_LOG_PATH,
  TRAEFIK_LOGROTATE_PATH,
  TRAEFIK_METRICS_PORT,
  WAKER_HTTP_PORT,
} from "./traefik-constants.ts";

// The db module (and its temp data dir) is shared across all test files in
// the bun test process, so every fixture uses unique names and assertions
// select their own slice of the rendered config.

function makeServer(privateIpv4 = `10.0.0.${Math.floor(Math.random() * 200) + 2}`) {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "203.0.113.10",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    private_ipv4: privateIpv4,
  });
}

function makeApp(opts: {
  server: { id: number };
  domain?: string;
  isPublic?: boolean;
  healthCheck?: boolean;
  internalProtocol?: "http" | "tcp";
  authPassword?: string;
  replicaStatus?: string | null; // null = no replica at all
  hostPort?: number;
  status?: string;
  sticky?: boolean;
  rateLimitRps?: number;
  ipAllowlist?: string;
  healthCheckPath?: string;
  compress?: boolean;
  publicPort?: number;
  publicProtocol?: "tcp" | "udp";
} ) {
  const name = `app-${randomSuffix()}`;
  const app = db.insertApp({
    name,
    domain: opts.domain ?? `${name}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    public: opts.isPublic ?? true,
    health_check: opts.healthCheck ?? true,
    internal_protocol: opts.internalProtocol,
    auth_password: opts.authPassword,
    sticky: opts.sticky,
    rate_limit_rps: opts.rateLimitRps,
    ip_allowlist: opts.ipAllowlist,
    health_check_path: opts.healthCheckPath,
    compress: opts.compress,
    public_port: opts.publicPort,
    public_protocol: opts.publicProtocol,
  });
  if (opts.replicaStatus !== null) {
    db.insertReplica({
      app_id: app.id,
      server_id: opts.server.id,
      host_port: opts.hostPort ?? 10001,
      container_name: name,
      status: opts.replicaStatus ?? "running",
    });
  }
  if (opts.status) db.updateAppStatus(app.id, opts.status);
  return db.getApp(app.id)!;
}

function stateFor(...appNames: string[]) {
  const state = collectDesiredState();
  return {
    ...state,
    apps: state.apps.filter((a) => appNames.includes(a.name)),
    services: [],
  };
}

function parse(config: string): any {
  return JSON.parse(config);
}

describe("traefikStaticConfig", () => {
  test("entrypoints: web/websecure only; the int20000-20199 internal block is gone (VIP proxy owns internal traffic)", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.web.address).toBe(":80");
    expect(cfg.entryPoints.websecure.address).toBe(":443");
    const intCount = Object.keys(cfg.entryPoints).filter((k) => k.startsWith("int")).length;
    expect(intCount).toBe(0);
    expect(
      Object.values(cfg.entryPoints).some((e: any) => e.address === ":20000"),
    ).toBe(false);
  });

  test("public raw TCP/UDP pool is NOT a set of Traefik entrypoints (owned by the VIP proxy now)", () => {
    // The 30000-30099 pool moved off Traefik onto the per-host VIP proxy
    // (nftables DNAT off the panel's public IP). Traefik must no longer reserve
    // those 100 static entrypoints fleet-wide.
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.pub30000).toBeUndefined();
    expect(cfg.entryPoints.pubu30050).toBeUndefined();
    const poolCount = Object.keys(cfg.entryPoints).filter((k) => /^pubu?\d/.test(k)).length;
    expect(poolCount).toBe(0);
  });

  test("prometheus metrics on the dedicated :8899 entrypoint (not internet-reachable — cloud firewall only opens 22/80/443)", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.metrics.address).toBe(`:${TRAEFIK_METRICS_PORT}`);
    expect(cfg.metrics.prometheus.entryPoint).toBe("metrics");
  });

  test("JSON access log with buffering to /var/log/traefik/access.log", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.accessLog).toEqual({
      filePath: TRAEFIK_ACCESS_LOG_PATH,
      format: "json",
      bufferingSize: 100,
    });
  });

  test("file provider watches the dynamic dir; ACME resolver uses httpChallenge on web; no dashboard", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.providers.file).toEqual({ directory: "/etc/traefik/dynamic", watch: true });
    expect(cfg.certificatesResolvers.letsencrypt.acme.httpChallenge.entryPoint).toBe("web");
    expect(cfg.certificatesResolvers.letsencrypt.acme.storage).toBe("/etc/traefik/acme.json");
    expect(cfg.api.dashboard).toBe(false);
  });
});

describe("renderDynamicConfig", () => {
  test("workers render an empty config — internal routing belongs to the VIP proxy now", () => {
    const server = makeServer("10.0.1.2");
    const httpApp = makeApp({ server, hostPort: 10042 });
    const tcpApp = makeApp({ server, internalProtocol: "tcp", healthCheck: false, hostPort: 10050 });
    const gatedApp = makeApp({ server, authPassword: "pw", hostPort: 10044, domain: "g.example.com" });
    const cfg = renderDynamicConfig(stateFor(httpApp.name, tcpApp.name, gatedApp.name), { isPanel: false });
    expect(parse(cfg)).toEqual({});
  });

  test("no rendered router ever targets an int* entrypoint", () => {
    const server = makeServer("10.0.1.22");
    const httpApp = makeApp({ server, hostPort: 10043 });
    const gatedApp = makeApp({ server, authPassword: "pw", hostPort: 10045, domain: "g2.example.com" });
    const cfg = renderDynamicConfig(stateFor(httpApp.name, gatedApp.name), { isPanel: true });
    expect(cfg).not.toContain("int-");
    expect(cfg).not.toContain("int2");
    expect(cfg).not.toContain("internal-http");
  });

  test("auth-protected app: basicAuth middleware on the public router, upstreams at the replica port", () => {
    const server = makeServer("10.0.1.4");
    const app = makeApp({ server, authPassword: "hunter2", hostPort: 10060, domain: "gated.example.com" });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    // No sidecar anymore: upstreams dial the replica's host port directly.
    expect(cfg.http.services[`app-${app.name}`].loadBalancer.servers).toEqual([
      { url: "http://10.0.1.4:10060" },
    ]);

    // htpasswd entry: fixed username + the bcrypt hash persisted at set-time.
    const users = cfg.http.middlewares[`auth-${app.name}`].basicAuth.users;
    expect(users).toHaveLength(1);
    expect(users[0].startsWith(`${BASIC_AUTH_USER}:$2`)).toBe(true);
    const hash = users[0].slice(`${BASIC_AUTH_USER}:`.length);
    expect(hash).toBe(app.auth_password_hash);
    expect(Bun.password.verifySync("hunter2", hash)).toBe(true);

    expect(cfg.http.routers[`pub-${app.name}`].middlewares).toEqual([`auth-${app.name}`, "sec-headers", "retry"]);
  });

  test("render gates on auth_password_hash: setting/clearing the hash toggles basicAuth", () => {
    const server = makeServer("10.0.1.24");
    const app = makeApp({ server, hostPort: 10062, domain: "gate2.example.com" });

    // No password yet — no basicAuth middleware.
    let cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.middlewares[`auth-${app.name}`]).toBeUndefined();

    // Setting the password writes only the hash; the renderer gates on the hash
    // (not any plaintext), so the middleware appears.
    db.updateAppAuthPassword(app.id, "s3cret");
    cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    const users = cfg.http.middlewares[`auth-${app.name}`].basicAuth.users;
    expect(Bun.password.verifySync("s3cret", users[0].slice(`${BASIC_AUTH_USER}:`.length))).toBe(true);

    // Clearing the hash disables auth and drops the middleware.
    db.updateAppAuthPassword(app.id, "");
    cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.middlewares[`auth-${app.name}`]).toBeUndefined();
  });

  test("tcp-routed public app still proxies HTTP on its domain (same as the old public vhost)", () => {
    const server = makeServer("10.0.1.14");
    const app = makeApp({ server, internalProtocol: "tcp", healthCheck: false, hostPort: 10061, domain: "tcpish.example.com" });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(cfg.tcp).toBeUndefined();
    expect(cfg.http.routers[`pub-${app.name}`].service).toBe(`app-${app.name}`);
    expect(cfg.http.services[`app-${app.name}`].loadBalancer.servers).toEqual([
      { url: "http://10.0.1.14:10061" },
    ]);
  });

  test("auth-protected app renders deterministically (hash persisted, not re-derived)", () => {
    const server = makeServer("10.0.1.15");
    const app = makeApp({ server, authPassword: "hunter2", hostPort: 10062 });
    const first = renderDynamicConfig(stateFor(app.name), { isPanel: true });
    const second = renderDynamicConfig(stateFor(app.name), { isPanel: true });
    expect(first).toBe(second);
  });

  test("public routers render only on the panel, with sec-headers + certResolver", () => {
    const server = makeServer("10.0.1.5");
    const app = makeApp({ server, domain: "shop.example.com", hostPort: 10070 });

    const worker = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    expect(worker.http?.routers?.[`pub-${app.name}`]).toBeUndefined();

    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    const pub = panel.http.routers[`pub-${app.name}`];
    expect(pub.entryPoints).toEqual(["websecure"]);
    expect(pub.rule).toBe("Host(`shop.example.com`)");
    expect(pub.middlewares).toEqual(["sec-headers", "retry"]);
    expect(pub.service).toBe(`app-${app.name}`);
    expect(pub.tls).toEqual({ certResolver: "letsencrypt" });
    expect(panel.http.middlewares["sec-headers"].headers.customResponseHeaders).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-XSS-Protection": "1; mode=block",
    });
    // Global web→websecure redirect exists on the panel.
    const redirect = panel.http.routers["web-to-https"];
    expect(redirect.entryPoints).toEqual(["web"]);
    expect(redirect.middlewares).toEqual(["redirect-https"]);
    expect(panel.http.middlewares["redirect-https"]).toEqual({
      redirectScheme: { scheme: "https", permanent: true },
    });
  });

  test("private app (empty domain) renders nothing even on the panel — the VIP proxy serves it", () => {
    const server = makeServer("10.0.1.6");
    const app = makeApp({ server, isPublic: false, domain: "" });
    const cfg = renderDynamicConfig(stateFor(app.name), { isPanel: true });
    expect(cfg).not.toContain(app.name);
  });

  test("nip.io domain uses tls: {} (default self-signed cert), not the ACME resolver", () => {
    const server = makeServer("10.0.1.7");
    const app = makeApp({ server, domain: `x.203-0-113-10.nip.io` });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.routers[`pub-${app.name}`].tls).toEqual({});
  });

  test("sleeping public app routes its domain to the waker", () => {
    const panelServer = makeServer("10.0.1.8");
    db.deletePanel(); // panel is a singleton shared across test files
    db.insertPanel({
      server_id: panelServer.id,
      name: `panel-${randomSuffix()}`,
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001,
      host_port: 3001,
    });
    const app = makeApp({
      server: panelServer,
      domain: "sleepy.example.com",
      replicaStatus: "stopped", // sleep anchor — not servable
      status: "sleeping",
    });
    const state = stateFor(app.name);
    // Panel private IP is where every server's Traefik reaches the waker.
    expect(state.panelPrivateIpv4).toBe("10.0.1.8");
    const cfg = parse(renderDynamicConfig(state, { isPanel: true }));

    // Public domain router → shared waker HTTP service (not the old ocd-panel).
    const pub = cfg.http.routers[`pub-${app.name}`];
    expect(pub.service).toBe("ocd-waker-http");
    expect(pub.rule).toBe("Host(`sleepy.example.com`)");
    expect(cfg.http.services["ocd-waker-http"].loadBalancer.servers).toEqual([
      { url: `http://10.0.1.8:${WAKER_HTTP_PORT}` },
    ]);
    // The old panel wake service is gone.
    expect(cfg.http.services["ocd-panel"]).toBeUndefined();
    // No real upstream pool for the sleeping app itself.
    expect(cfg.http.services[`app-${app.name}`]).toBeUndefined();
    // Workers render nothing — internal wake is the VIP proxy's job.
    const worker = renderDynamicConfig(state, { isPanel: false });
    expect(worker).not.toContain(app.name);
    db.deletePanel();
  });

  test("sleeping app renders nothing when the panel has no private IP (no waker to reach)", () => {
    // Panel server without a private_ipv4 — nowhere to route the waker.
    const panelServer = db.insertServer({
      name: `srv-${randomSuffix()}`, provider_id: `h-${randomSuffix()}`,
      ipv4: "203.0.113.10", ipv6: "", type: "cx22", location: "fsn1", status: "ready",
    });
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer, domain: "nowaker.example.com",
      replicaStatus: "stopped", status: "sleeping",
    });
    const state = stateFor(app.name);
    expect(state.panelPrivateIpv4).toBeNull();
    const cfg = renderDynamicConfig(state, { isPanel: true });
    expect(cfg).not.toContain(app.name);
    db.deletePanel();
  });

  test("app with zero servable upstreams renders nothing", () => {
    const server = makeServer("10.0.1.9");
    const appNoReplica = makeApp({ server, replicaStatus: null });
    const appDraining = makeApp({ server, replicaStatus: "draining" });
    const cfg = renderDynamicConfig(stateFor(appNoReplica.name, appDraining.name), { isPanel: false });
    expect(cfg).not.toContain(appNoReplica.name);
    expect(cfg).not.toContain(appDraining.name);
  });

  test("managed HTTP service gets a panel-only single-upstream vhost", () => {
    const server = makeServer("10.0.1.10");
    const name = `svc-${randomSuffix()}`;
    const svc = db.insertService({
      name,
      service_type: "n8n",
      version: "latest",
      port: 5678,
      env_vars: "{}",
      credentials: JSON.stringify({ domain: `${name}.example.com` }),
    });
    const instance = db.insertServiceInstance({
      service_id: svc.id,
      server_id: server.id,
      role: "primary",
      container_name: name,
      host_port: 11001,
    });

    const state = collectDesiredState();
    const desired = state.services.find((s) => s.name === name);
    expect(desired).toEqual({
      name,
      domain: `${name}.example.com`,
      upstream: "10.0.1.10:11001",
    });

    const panel = parse(renderDynamicConfig({ ...state, apps: [] }, { isPanel: true }));
    const router = panel.http.routers[`svc-${name}`];
    expect(router.rule).toBe(`Host(\`${name}.example.com\`)`);
    expect(router.middlewares).toEqual(["svc-headers", "retry"]);
    expect(router.tls).toEqual({ certResolver: "letsencrypt" });
    expect(panel.http.services[`svc-${name}`].loadBalancer.servers).toEqual([
      { url: "http://10.0.1.10:11001" },
    ]);

    const worker = parse(renderDynamicConfig({ ...state, apps: [] }, { isPanel: false }));
    expect(worker.http?.routers?.[`svc-${name}`]).toBeUndefined();

    // service_instances.server_id has no ON DELETE CASCADE — clean up so
    // other test files' deleteServer sweeps don't hit the FK constraint.
    db.deleteServiceInstance(instance.id);
    db.deleteService(svc.id);
  });

  test("sticky sessions: cookie affinity on the app's HTTP service; off by default", () => {
    const server = makeServer("10.0.2.2");
    const plain = makeApp({ server, hostPort: 10100 });
    const sticky = makeApp({ server, sticky: true, hostPort: 10101 });
    const cfg = parse(renderDynamicConfig(stateFor(plain.name, sticky.name), { isPanel: true }));

    expect(cfg.http.services[`app-${plain.name}`].loadBalancer.sticky).toBeUndefined();
    expect(cfg.http.services[`app-${sticky.name}`].loadBalancer.sticky).toEqual({
      cookie: { name: "ocd_sticky", httpOnly: true, secure: true, sameSite: "lax" },
    });
    expect(cfg.http.routers[`pub-${sticky.name}`].service).toBe(`app-${sticky.name}`);
  });

  test("active HTTP health check: path renders on the HTTP loadBalancer", () => {
    const server = makeServer("10.0.2.3");
    const httpApp = makeApp({ server, healthCheckPath: "/healthz", hostPort: 10110 });

    const cfg = parse(renderDynamicConfig(stateFor(httpApp.name), { isPanel: true }));
    expect(cfg.http.services[`app-${httpApp.name}`].loadBalancer.healthCheck).toEqual({
      path: "/healthz",
      interval: "10s",
      timeout: "3s",
    });
  });

  test("rate limit: ratelimit middleware (burst = 2x) on the pub- router only", () => {
    const server = makeServer("10.0.2.4");
    const app = makeApp({ server, rateLimitRps: 50, hostPort: 10120 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`ratelimit-${app.name}`]).toEqual({
      rateLimit: { average: 50, burst: 100 },
    });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `ratelimit-${app.name}`, "sec-headers", "retry",
    ]);
    // Workers render no pub- router, so the middleware must not orphan there.
    const worker = renderDynamicConfig(stateFor(app.name), { isPanel: false });
    expect(worker).not.toContain(`ratelimit-${app.name}`);
  });

  test("IP allowlist: parsed comma-separated entries as ipAllowList sourceRange on the pub- router only", () => {
    const server = makeServer("10.0.2.5");
    const app = makeApp({ server, ipAllowlist: "203.0.113.7, 10.0.0.0/8 ,2001:db8::/32", hostPort: 10130 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`allowlist-${app.name}`]).toEqual({
      ipAllowList: { sourceRange: ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"] },
    });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `allowlist-${app.name}`, "sec-headers", "retry",
    ]);
  });

  test("compression: compress middleware on the pub- router only", () => {
    const server = makeServer("10.0.2.6");
    const app = makeApp({ server, compress: true, hostPort: 10140 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`compress-${app.name}`]).toEqual({ compress: {} });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `compress-${app.name}`, "sec-headers", "retry",
    ]);
  });

  test("pub- middleware order: allowlist → ratelimit → auth → compress → sec-headers → retry (cheap rejections before bcrypt)", () => {
    const server = makeServer("10.0.2.7");
    const app = makeApp({
      server,
      authPassword: "hunter2",
      sticky: true,
      rateLimitRps: 10,
      ipAllowlist: "10.0.0.0/8",
      healthCheckPath: "/up",
      compress: true,
      hostPort: 10150,
    });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `allowlist-${app.name}`,
      `ratelimit-${app.name}`,
      `auth-${app.name}`,
      `compress-${app.name}`,
      "sec-headers",
      "retry",
    ]);
    // Service-level options coexist with the middleware chain.
    const lb = panel.http.services[`app-${app.name}`].loadBalancer;
    expect(lb.sticky.cookie.name).toBe("ocd_sticky");
    expect(lb.healthCheck.path).toBe("/up");
  });

  test("public raw TCP/UDP exposure renders NO Traefik tcp/udp config (owned by the VIP proxy now)", () => {
    // A TCP-exposed app with a public HTTP domain and a UDP-exposed private
    // app: Traefik renders the HTTP path as before, but emits nothing for the
    // raw ports — no tcp/udp sections at all. The raw path lives on the proxy
    // (see proxy-render.test.ts / nat.test.ts).
    const server = makeServer("10.0.3.2");
    const tcpApp = makeApp({ server, domain: "game.example.com", publicPort: 30040, hostPort: 10160 });
    const udpApp = makeApp({ server, isPublic: false, domain: "", publicPort: 30090, publicProtocol: "udp", hostPort: 10170 });
    const panel = parse(renderDynamicConfig(stateFor(tcpApp.name, udpApp.name), { isPanel: true }));

    // The HTTP domain of the TCP-exposed app is untouched.
    expect(panel.http.routers[`pub-${tcpApp.name}`]).toBeDefined();
    // But no raw ingress objects, and no tcp/udp roots.
    expect(panel.tcp).toBeUndefined();
    expect(panel.udp).toBeUndefined();
    const raw = renderDynamicConfig(stateFor(tcpApp.name, udpApp.name), { isPanel: true });
    expect(raw).not.toContain("pubtcp-");
    expect(raw).not.toContain("pubudp-");
    // A UDP-only private app has no HTTP presence either — renders nothing.
    expect(panel.http?.routers?.[`pub-${udpApp.name}`]).toBeUndefined();
  });

  test("password-protected sleeping app keeps basicAuth in front of the waker", () => {
    const panelServer = makeServer("10.0.3.8");
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer, authPassword: "hunter2", domain: "gated-sleep.example.com",
      replicaStatus: "stopped", status: "sleeping",
    });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    // The wake path must stay password-gated: auth middleware renders and is
    // attached to the public waker router.
    expect(cfg.http.middlewares[`auth-${app.name}`]).toBeDefined();
    expect(cfg.http.routers[`pub-${app.name}`].middlewares).toContain(`auth-${app.name}`);
    expect(cfg.http.routers[`pub-${app.name}`].service).toBe("ocd-waker-http");
    db.deletePanel();
  });

  test("output is deterministic (stable key order) for the content-hash cache", () => {
    const server = makeServer("10.0.1.11");
    const b = makeApp({ server, hostPort: 10081 });
    const a = makeApp({ server, healthCheck: false, hostPort: 10082 });
    const first = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    const second = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    expect(first).toBe(second);
    // collectDesiredState sorts apps by name, so a fresh snapshot renders
    // byte-identically too.
    const third = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    expect(third).toBe(first);
  });
});

describe("renderPanelConfig", () => {
  test("panel vhost: websecure router + web redirect, names disjoint from ocd.yml", () => {
    const cfg = parse(renderPanelConfig("panel.example.com", 3001));
    expect(cfg.http.routers.panel.rule).toBe("Host(`panel.example.com`)");
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers["panel-web"].entryPoints).toEqual(["web"]);
    expect(cfg.http.services.panel.loadBalancer.servers).toEqual([
      { url: "http://127.0.0.1:3001" },
    ]);
    // nip.io → default self-signed cert
    const nip = parse(renderPanelConfig("1-2-3-4.nip.io", 3001));
    expect(nip.http.routers.panel.tls).toEqual({});
  });

  test("every real panel domain uses HTTP-01", () => {
    const cfg = parse(renderPanelConfig("panel.zone-test.dev", 3001));
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
  });
});

describe("publicTls (HTTP-01 only)", () => {
  test("every real domain uses HTTP-01 and nip.io stays self-signed", () => {
    expect(publicTls("myapp.zone-test.dev")).toEqual({ certResolver: "letsencrypt" });
    expect(publicTls("a.b.zone-test.dev")).toEqual({ certResolver: "letsencrypt" });
    expect(publicTls("x.1-2-3-4.nip.io")).toEqual({});
  });

  test("renderDynamicConfig uses HTTP-01 for default-suffix and custom domains", () => {
    const server = makeServer("10.0.1.12");
    const auto = makeApp({ server, domain: "auto.zone-test.dev", hostPort: 10090 });
    const custom = makeApp({ server, domain: "shop.custom-domain.io", hostPort: 10091 });
    const state = collectDesiredState();
    const cfg = parse(renderDynamicConfig(
      { ...state, apps: state.apps.filter((a) => [auto.name, custom.name].includes(a.name)), services: [] },
      { isPanel: true },
    ));
    expect(cfg.http.routers[`pub-${auto.name}`].tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers[`pub-${custom.name}`].tls).toEqual({ certResolver: "letsencrypt" });
  });
});

describe("HTTP-01 static config / unit / install script", () => {
  test("only the HTTP-01 resolver is configured", () => {
    const cfg = parse(traefikStaticConfig());
    expect(Object.keys(cfg.certificatesResolvers)).toEqual(["letsencrypt"]);
    expect(cfg.certificatesResolvers.letsencrypt.acme.httpChallenge).toEqual({ entryPoint: "web" });
    expect(cfg.certificatesResolvers.letsencrypt.acme.storage).toBe("/etc/traefik/acme.json");
  });

  test("systemd and install script contain no DNS provider secret plumbing", () => {
    expect(traefikSystemdUnit()).not.toContain("EnvironmentFile");
    const script = traefikInstallScript();
    expect(script).toContain("chmod 600 /etc/traefik/acme.json");
    expect(script).not.toContain("acme-dns.json");
    expect(script).not.toContain("HETZNER_API_KEY");
  });

  test("install script creates the access-log dir and a logrotate policy so disks never fill", () => {
    const script = traefikInstallScript();
    expect(script).toContain("mkdir -p /var/log/traefik");
    expect(script).toContain(TRAEFIK_LOGROTATE_PATH);
    expect(script).toContain(`${TRAEFIK_ACCESS_LOG_PATH} {`);
    expect(script).toContain("daily");
    expect(script).toContain("rotate 7");
    expect(script).toContain("compress");
    // copytruncate: Traefik keeps the log fd open — rotate without signaling.
    expect(script).toContain("copytruncate");
  });
});
