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
  TRAEFIK_ACME_DNS_PATH,
  TRAEFIK_ENV_PATH,
  TRAEFIK_LOGROTATE_PATH,
  TRAEFIK_METRICS_PORT,
  WAKER_HTTP_PORT,
  wakerTcpPort,
  wakerUdpPort,
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
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
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
  test("entrypoints: web/websecure + the full internal port block; no legacy :8080 compat entrypoint", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.web.address).toBe(":80");
    expect(cfg.entryPoints.websecure.address).toBe(":443");
    // The pre-Traefik :8080 internal-http compat entrypoint is gone.
    expect(cfg.entryPoints["internal-http"]).toBeUndefined();
    expect(
      Object.values(cfg.entryPoints).some((e: any) => e.address === ":8080"),
    ).toBe(false);
    expect(cfg.entryPoints.int20000.address).toBe(":20000");
    expect(cfg.entryPoints.int20199.address).toBe(":20199");
    expect(cfg.entryPoints.int20200).toBeUndefined();
    const intCount = Object.keys(cfg.entryPoints).filter((k) => k.startsWith("int2")).length;
    expect(intCount).toBe(db.INTERNAL_PORT_COUNT);
  });

  test("public raw TCP/UDP pool: pub30000-pub30049 (tcp) + pubu30050-pubu30099 (udp, /udp suffix)", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.pub30000.address).toBe(":30000");
    expect(cfg.entryPoints.pub30049.address).toBe(":30049");
    expect(cfg.entryPoints.pub30050).toBeUndefined();
    expect(cfg.entryPoints.pubu30050.address).toBe(":30050/udp");
    expect(cfg.entryPoints.pubu30099.address).toBe(":30099/udp");
    expect(cfg.entryPoints.pubu30100).toBeUndefined();
    const tcpCount = Object.keys(cfg.entryPoints).filter((k) => /^pub\d/.test(k)).length;
    const udpCount = Object.keys(cfg.entryPoints).filter((k) => k.startsWith("pubu")).length;
    expect(tcpCount).toBe(db.PUBLIC_TCP_PORT_COUNT);
    expect(udpCount).toBe(db.PUBLIC_UDP_PORT_COUNT);
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
  test("HTTP app: loadBalancer service + internal entrypoint router; no :8080 compat router", () => {
    const server = makeServer("10.0.1.2");
    const app = makeApp({ server, hostPort: 10042 });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));

    const svc = cfg.http.services[`app-${app.name}`];
    expect(svc.loadBalancer.servers).toEqual([{ url: "http://10.0.1.2:10042" }]);

    const intRouter = cfg.http.routers[`int-${app.name}`];
    expect(intRouter.entryPoints).toEqual([`int${app.internal_port}`]);
    expect(intRouter.rule).toBe("PathPrefix(`/`)");
    expect(intRouter.service).toBe(`app-${app.name}`);
    expect(intRouter.middlewares).toEqual(["retry"]);

    // The legacy compat-<app> router on the :8080 internal-http entrypoint is
    // gone: apps reach each other only via <app>.ocd.internal:<internal_port>.
    expect(cfg.http.routers[`compat-${app.name}`]).toBeUndefined();

    expect(cfg.http.middlewares.retry).toEqual({ retry: { attempts: 3 } });
    // Not the panel: no public router, no redirect.
    expect(cfg.http.routers[`pub-${app.name}`]).toBeUndefined();
    expect(cfg.http.routers["web-to-https"]).toBeUndefined();
  });

  test("no rendered router ever targets the removed internal-http entrypoint", () => {
    const server = makeServer("10.0.1.22");
    const httpApp = makeApp({ server, hostPort: 10043 });
    const gatedApp = makeApp({ server, authPassword: "pw", hostPort: 10044, domain: "g.example.com" });
    const cfg = renderDynamicConfig(stateFor(httpApp.name, gatedApp.name), { isPanel: true });
    expect(cfg).not.toContain("internal-http");
    expect(cfg).not.toContain("compat-");
  });

  test("health_check=0 app: TCP router with HostSNI(`*`) + TCP health check, no compat router", () => {
    const server = makeServer("10.0.1.3");
    const app = makeApp({ server, healthCheck: false, hostPort: 10050 });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));

    const router = cfg.tcp.routers[`int-${app.name}`];
    expect(router.rule).toBe("HostSNI(`*`)");
    expect(router.entryPoints).toEqual([`int${app.internal_port}`]);
    expect(router.service).toBe(`app-${app.name}`);

    const svc = cfg.tcp.services[`app-${app.name}`];
    expect(svc.loadBalancer.servers).toEqual([{ address: "10.0.1.3:10050" }]);
    expect(svc.loadBalancer.healthCheck).toEqual({ interval: "10s", timeout: "3s" });

    expect(cfg.http?.routers?.[`compat-${app.name}`]).toBeUndefined();
  });

  test("auth-protected app: basicAuth middleware on every HTTP router, upstreams at the replica port", () => {
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

    // The middleware guards internal and public routers alike — matching the
    // old proxy, which sat in front of every upstream.
    expect(cfg.http.routers[`int-${app.name}`].middlewares).toEqual([`auth-${app.name}`, "retry"]);
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

  test("auth-protected health_check=0 app routes as HTTP with basicAuth (no TCP bypass)", () => {
    const server = makeServer("10.0.1.14");
    const app = makeApp({ server, authPassword: "hunter2", healthCheck: false, hostPort: 10061 });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));

    // A raw TCP router would skip basicAuth entirely; the old auth proxy was
    // an HTTP server too, so these apps stay HTTP-routed.
    expect(cfg.tcp).toBeUndefined();
    expect(cfg.http.routers[`int-${app.name}`].middlewares).toEqual([`auth-${app.name}`, "retry"]);
    expect(cfg.http.services[`app-${app.name}`].loadBalancer.servers).toEqual([
      { url: "http://10.0.1.14:10061" },
    ]);
  });

  test("routing follows internal_protocol, not health_check: http probe + tcp routing → TCP router", () => {
    // Decoupling: an app can run the HTTP probe (health_check=1) yet route raw
    // TCP internally (internal_protocol='tcp'). Routing must key off the
    // explicit protocol, not the probe flag.
    const server = makeServer("10.0.1.30");
    const app = makeApp({ server, healthCheck: true, internalProtocol: "tcp", hostPort: 10080 });
    expect(app.health_check).toBe(1);
    expect(app.internal_protocol).toBe("tcp");
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    // TCP router, no HTTP router.
    expect(cfg.tcp.routers[`int-${app.name}`].rule).toBe("HostSNI(`*`)");
    expect(cfg.http?.routers?.[`int-${app.name}`]).toBeUndefined();
  });

  test("routing follows internal_protocol, not health_check: no probe + http routing → HTTP router", () => {
    // Inverse: no HTTP probe (health_check=0) but explicit HTTP routing.
    const server = makeServer("10.0.1.31");
    const app = makeApp({ server, healthCheck: false, internalProtocol: "http", hostPort: 10081 });
    expect(app.health_check).toBe(0);
    expect(app.internal_protocol).toBe("http");
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    // HTTP router, no TCP router. The active health-check path is gated on the
    // probe flag, so this HTTP loadBalancer carries no healthCheck block.
    expect(cfg.http.routers[`int-${app.name}`].rule).toBe("PathPrefix(`/`)");
    expect(cfg.tcp?.routers?.[`int-${app.name}`]).toBeUndefined();
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
    expect(worker.http.routers[`pub-${app.name}`]).toBeUndefined();

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

  test("private app (empty domain) gets no public router even on the panel", () => {
    const server = makeServer("10.0.1.6");
    const app = makeApp({ server, isPublic: false, domain: "" });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.routers[`pub-${app.name}`]).toBeUndefined();
    // Internal routing still present.
    expect(cfg.http.routers[`int-${app.name}`]).toBeDefined();
  });

  test("nip.io domain uses tls: {} (default self-signed cert), not the ACME resolver", () => {
    const server = makeServer("10.0.1.7");
    const app = makeApp({ server, domain: `x.203-0-113-10.nip.io` });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.routers[`pub-${app.name}`].tls).toEqual({});
  });

  test("sleeping public app routes its domain (and internal router) to the waker", () => {
    const panelServer = makeServer("10.0.1.8");
    db.deletePanel(); // panel is a singleton shared across test files
    db.insertPanel({
      server_id: panelServer.id,
      name: `panel-${randomSuffix()}`,
      domain: "panel.example.com",
      git_repo: "https://github.com/x/panel",
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
    // Internal router also points at the waker (internal callers wake it too).
    expect(cfg.http.routers[`int-${app.name}`].service).toBe("ocd-waker-http");
    // No real upstream pool for the sleeping app itself.
    expect(cfg.http.services[`app-${app.name}`]).toBeUndefined();
    // Workers render the internal waker router (internal traffic originates
    // anywhere) but not the panel-only public one.
    const worker = parse(renderDynamicConfig(state, { isPanel: false }));
    expect(worker.http.routers[`int-${app.name}`].service).toBe("ocd-waker-http");
    expect(worker.http?.routers?.[`pub-${app.name}`]).toBeUndefined();
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
      domain: "panel.example.com", git_repo: "https://github.com/x/panel",
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

  test("sticky sessions: cookie affinity on the app's HTTP service (public + internal alike); off by default", () => {
    const server = makeServer("10.0.2.2");
    const plain = makeApp({ server, hostPort: 10100 });
    const sticky = makeApp({ server, sticky: true, hostPort: 10101 });
    const cfg = parse(renderDynamicConfig(stateFor(plain.name, sticky.name), { isPanel: true }));

    expect(cfg.http.services[`app-${plain.name}`].loadBalancer.sticky).toBeUndefined();
    expect(cfg.http.services[`app-${sticky.name}`].loadBalancer.sticky).toEqual({
      cookie: { name: "ocd_sticky", httpOnly: true, secure: true, sameSite: "lax" },
    });
    // Service-level, so internal routers share the same sticky service.
    expect(cfg.http.routers[`int-${sticky.name}`].service).toBe(`app-${sticky.name}`);
  });

  test("active HTTP health check: path on the HTTP loadBalancer; TCP apps keep the plain TCP check", () => {
    const server = makeServer("10.0.2.3");
    const httpApp = makeApp({ server, healthCheckPath: "/healthz", hostPort: 10110 });
    const tcpApp = makeApp({ server, healthCheck: false, isPublic: false, domain: "", hostPort: 10111 });
    // Simulate a stale row: a path set on a TCP-routed app must not render.
    db.updateAppIngressSettings(tcpApp.id, { health_check_path: "/healthz" });

    const cfg = parse(renderDynamicConfig(stateFor(httpApp.name, tcpApp.name), { isPanel: false }));
    expect(cfg.http.services[`app-${httpApp.name}`].loadBalancer.healthCheck).toEqual({
      path: "/healthz",
      interval: "10s",
      timeout: "3s",
    });
    expect(cfg.tcp.services[`app-${tcpApp.name}`].loadBalancer.healthCheck).toEqual({
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
    // Internal traffic is trusted — no rate limit on the internal router.
    expect(panel.http.routers[`int-${app.name}`].middlewares).toEqual(["retry"]);
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
    expect(panel.http.routers[`int-${app.name}`].middlewares).toEqual(["retry"]);
  });

  test("compression: compress middleware on the pub- router only", () => {
    const server = makeServer("10.0.2.6");
    const app = makeApp({ server, compress: true, hostPort: 10140 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`compress-${app.name}`]).toEqual({ compress: {} });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `compress-${app.name}`, "sec-headers", "retry",
    ]);
    expect(panel.http.routers[`int-${app.name}`].middlewares).toEqual(["retry"]);
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
    // Internal routers keep auth only.
    expect(panel.http.routers[`int-${app.name}`].middlewares).toEqual([`auth-${app.name}`, "retry"]);
    // Service-level options coexist with the middleware chain.
    const lb = panel.http.services[`app-${app.name}`].loadBalancer;
    expect(lb.sticky.cookie.name).toBe("ocd_sticky");
    expect(lb.healthCheck.path).toBe("/up");
  });

  test("public TCP port: pubtcp router/service on the panel only, coexisting with the HTTP pub- router", () => {
    const server = makeServer("10.0.3.2");
    const app = makeApp({ server, domain: "game.example.com", publicPort: 30040, hostPort: 10160 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    const router = panel.tcp.routers[`pubtcp-${app.name}`];
    expect(router).toEqual({
      entryPoints: ["pub30040"],
      rule: "HostSNI(`*`)",
      service: `pubtcp-${app.name}`,
    });
    expect(panel.tcp.services[`pubtcp-${app.name}`].loadBalancer).toEqual({
      servers: [{ address: "10.0.3.2:10160" }],
      healthCheck: { interval: "10s", timeout: "3s" },
    });
    // Orthogonal to HTTP ingress: the pub- domain router still renders.
    expect(panel.http.routers[`pub-${app.name}`]).toBeDefined();

    // Workers never route the public pool.
    const worker = renderDynamicConfig(stateFor(app.name), { isPanel: false });
    expect(worker).not.toContain(`pubtcp-${app.name}`);
  });

  test("public UDP port: minimal udp router/service shape (no rule, no health check), panel only", () => {
    const server = makeServer("10.0.3.3");
    const app = makeApp({ server, publicPort: 30090, publicProtocol: "udp", hostPort: 10170 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.udp.routers[`pubudp-${app.name}`]).toEqual({
      entryPoints: ["pubu30090"],
      service: `pubudp-${app.name}`,
    });
    // UDP loadBalancers support no health checks — shape is just the pool.
    expect(panel.udp.services[`pubudp-${app.name}`].loadBalancer).toEqual({
      servers: [{ address: "10.0.3.3:10170" }],
    });

    const worker = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    expect(worker.udp).toBeUndefined();
  });

  test("HTTP-private app (public=0, no domain) can still be raw TCP-exposed", () => {
    const server = makeServer("10.0.3.4");
    const app = makeApp({ server, isPublic: false, domain: "", publicPort: 30041, hostPort: 10180 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.tcp.routers[`pubtcp-${app.name}`].entryPoints).toEqual(["pub30041"]);
    expect(panel.http?.routers?.[`pub-${app.name}`]).toBeUndefined();
  });

  test("sleeping app routes its public raw TCP port to the app's waker TCP port", () => {
    const panelServer = makeServer("10.0.3.5");
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", git_repo: "https://github.com/x/panel",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer,
      isPublic: false,
      domain: "",
      publicPort: 30042,
      replicaStatus: "stopped",
      status: "sleeping",
    });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    // The public TCP router now exists (previously it simply failed) and its
    // service dials the app's dedicated waker TCP port on the panel private IP.
    expect(panel.tcp.routers[`pubtcp-${app.name}`].entryPoints).toEqual(["pub30042"]);
    expect(panel.tcp.services[`pubtcp-${app.name}`].loadBalancer).toEqual({
      servers: [{ address: `10.0.3.5:${wakerTcpPort(app.internal_port)}` }],
    });
    // Waker service has no active health check (the waker is always up).
    expect(panel.tcp.services[`pubtcp-${app.name}`].loadBalancer.healthCheck).toBeUndefined();
    db.deletePanel();
  });

  test("sleeping raw-TCP app: internal router points at the app's waker TCP port on every server", () => {
    const panelServer = makeServer("10.0.3.6");
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", git_repo: "https://github.com/x/panel",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer, internalProtocol: "tcp", isPublic: false, domain: "",
      replicaStatus: "stopped", status: "sleeping",
    });
    const worker = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    expect(worker.tcp.routers[`int-${app.name}`].rule).toBe("HostSNI(`*`)");
    expect(worker.tcp.services[`app-${app.name}`].loadBalancer).toEqual({
      servers: [{ address: `10.0.3.6:${wakerTcpPort(app.internal_port)}` }],
    });
    db.deletePanel();
  });

  test("sleeping app routes its public UDP port to the app's waker UDP port", () => {
    const panelServer = makeServer("10.0.3.7");
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", git_repo: "https://github.com/x/panel",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer, publicPort: 30091, publicProtocol: "udp",
      replicaStatus: "stopped", status: "sleeping",
    });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(panel.udp.routers[`pubudp-${app.name}`].entryPoints).toEqual(["pubu30091"]);
    expect(panel.udp.services[`pubudp-${app.name}`].loadBalancer).toEqual({
      servers: [{ address: `10.0.3.7:${wakerUdpPort(app.internal_port)}` }],
    });
    db.deletePanel();
  });

  test("password-protected sleeping app keeps basicAuth in front of the waker", () => {
    const panelServer = makeServer("10.0.3.8");
    db.deletePanel();
    db.insertPanel({
      server_id: panelServer.id, name: `panel-${randomSuffix()}`,
      domain: "panel.example.com", git_repo: "https://github.com/x/panel",
      container_port: 3001, host_port: 3001,
    });
    const app = makeApp({
      server: panelServer, authPassword: "hunter2", domain: "gated-sleep.example.com",
      replicaStatus: "stopped", status: "sleeping",
    });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    // The wake path must stay password-gated: auth middleware renders and is
    // attached to both the internal and public waker routers.
    expect(cfg.http.middlewares[`auth-${app.name}`]).toBeDefined();
    expect(cfg.http.routers[`int-${app.name}`].middlewares).toEqual([`auth-${app.name}`, "retry"]);
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
    const cfg = parse(renderPanelConfig("panel.example.com", 3001, ""));
    expect(cfg.http.routers.panel.rule).toBe("Host(`panel.example.com`)");
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers["panel-web"].entryPoints).toEqual(["web"]);
    expect(cfg.http.services.panel.loadBalancer.servers).toEqual([
      { url: "http://127.0.0.1:3001" },
    ]);
    // nip.io → default self-signed cert
    const nip = parse(renderPanelConfig("1-2-3-4.nip.io", 3001, ""));
    expect(nip.http.routers.panel.tls).toEqual({});
  });

  test("panel domain under the managed zone rides the wildcard cert", () => {
    const cfg = parse(renderPanelConfig("panel.zone-test.dev", 3001, "zone-test.dev"));
    expect(cfg.http.routers.panel.tls).toEqual({
      certResolver: "letsencrypt-dns",
      domains: [{ main: "zone-test.dev", sans: ["*.zone-test.dev"] }],
    });
    // Outside the zone: per-domain HTTP-01 as before.
    const outside = parse(renderPanelConfig("panel.example.com", 3001, "zone-test.dev"));
    expect(outside.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
  });
});

describe("publicTls (zone-aware TLS selection)", () => {
  const wildcard = {
    certResolver: "letsencrypt-dns",
    domains: [{ main: "zone-test.dev", sans: ["*.zone-test.dev"] }],
  };

  test("single label under the zone (and the apex itself) → wildcard DNS-01", () => {
    expect(publicTls("myapp.zone-test.dev", "zone-test.dev")).toEqual(wildcard);
    expect(publicTls("zone-test.dev", "zone-test.dev")).toEqual(wildcard);
  });

  test("multi-level subdomain under the zone is NOT covered by *.<zone> → HTTP-01", () => {
    expect(publicTls("a.b.zone-test.dev", "zone-test.dev")).toEqual({
      certResolver: "letsencrypt",
    });
  });

  test("custom domain outside the zone keeps per-domain HTTP-01", () => {
    expect(publicTls("shop.example.com", "zone-test.dev")).toEqual({
      certResolver: "letsencrypt",
    });
    // Suffix look-alike is not under the zone.
    expect(publicTls("evilzone-test.dev", "zone-test.dev")).toEqual({
      certResolver: "letsencrypt",
    });
  });

  test("no zone configured → HTTP-01; nip.io → self-signed regardless of zone", () => {
    expect(publicTls("myapp.zone-test.dev", "")).toEqual({ certResolver: "letsencrypt" });
    expect(publicTls("x.1-2-3-4.nip.io", "")).toEqual({});
    expect(publicTls("x.1-2-3-4.nip.io", "zone-test.dev")).toEqual({});
  });

  test("renderDynamicConfig threads the snapshot's zone into public routers", () => {
    const server = makeServer("10.0.1.12");
    const auto = makeApp({ server, domain: "auto.zone-test.dev", hostPort: 10090 });
    const custom = makeApp({ server, domain: "shop.custom-domain.io", hostPort: 10091 });
    db.saveSetting("dns_zone_name", "zone-test.dev");
    try {
      const state = collectDesiredState();
      expect(state.zoneName).toBe("zone-test.dev");
      const cfg = parse(
        renderDynamicConfig(
          { ...state, apps: state.apps.filter((a) => [auto.name, custom.name].includes(a.name)), services: [] },
          { isPanel: true },
        ),
      );
      expect(cfg.http.routers[`pub-${auto.name}`].tls).toEqual(wildcard);
      expect(cfg.http.routers[`pub-${custom.name}`].tls).toEqual({
        certResolver: "letsencrypt",
      });
    } finally {
      db.saveSetting("dns_zone_name", "");
    }
  });
});

describe("wildcard resolver static config / unit / install script", () => {
  test("letsencrypt-dns resolver present only when a zone is configured, with separate storage + hetzner dnsChallenge", () => {
    expect(parse(traefikStaticConfig()).certificatesResolvers["letsencrypt-dns"]).toBeUndefined();
    db.saveSetting("dns_zone_name", "zone-test.dev");
    try {
      const cfg = parse(traefikStaticConfig());
      const dns = cfg.certificatesResolvers["letsencrypt-dns"];
      expect(dns.acme.dnsChallenge).toEqual({ provider: "hetzner" });
      // Distinct storage per resolver — Traefik forbids sharing acme.json.
      expect(dns.acme.storage).toBe(TRAEFIK_ACME_DNS_PATH);
      expect(cfg.certificatesResolvers.letsencrypt.acme.storage).toBe("/etc/traefik/acme.json");
      expect(dns.acme.email).toBe("admin@zone-test.dev");
    } finally {
      db.saveSetting("dns_zone_name", "");
    }
  });

  test("systemd unit references the optional env file; install script locks down acme-dns.json but never writes the secret", () => {
    expect(traefikSystemdUnit()).toContain(`EnvironmentFile=-${TRAEFIK_ENV_PATH}`);
    const script = traefikInstallScript();
    expect(script).toContain(`chmod 600 /etc/traefik/acme.json ${TRAEFIK_ACME_DNS_PATH}`);
    // The token must not land in cloud-init user data (shared by all servers).
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
