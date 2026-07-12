import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import { authProxyPort } from "../../shared/remote/index.ts";
import {
  collectDesiredState,
  renderDynamicConfig,
  renderPanelConfig,
  traefikStaticConfig,
  INTERNAL_HTTP_COMPAT_PORT,
} from "./traefik-config.ts";

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
  authPassword?: string;
  replicaStatus?: string | null; // null = no replica at all
  hostPort?: number;
  status?: string;
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
    auth_password: opts.authPassword,
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
  test("entrypoints: web/websecure/compat + the full internal port block", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.web.address).toBe(":80");
    expect(cfg.entryPoints.websecure.address).toBe(":443");
    expect(cfg.entryPoints["internal-http"].address).toBe(`:${INTERNAL_HTTP_COMPAT_PORT}`);
    expect(cfg.entryPoints.int20000.address).toBe(":20000");
    expect(cfg.entryPoints.int20199.address).toBe(":20199");
    expect(cfg.entryPoints.int20200).toBeUndefined();
    const intCount = Object.keys(cfg.entryPoints).filter((k) => k.startsWith("int2")).length;
    expect(intCount).toBe(db.INTERNAL_PORT_COUNT);
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
  test("HTTP app: loadBalancer service + internal entrypoint router + :8080 compat router", () => {
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

    const compat = cfg.http.routers[`compat-${app.name}`];
    expect(compat.entryPoints).toEqual(["internal-http"]);
    expect(compat.rule).toBe(`Host(\`${app.name}.ocd.internal\`)`);
    expect(compat.service).toBe(`app-${app.name}`);

    expect(cfg.http.middlewares.retry).toEqual({ retry: { attempts: 3 } });
    // Not the panel: no public router, no redirect.
    expect(cfg.http.routers[`pub-${app.name}`]).toBeUndefined();
    expect(cfg.http.routers["web-to-https"]).toBeUndefined();
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

  test("auth-protected app: upstreams point at the auth proxy port", () => {
    const server = makeServer("10.0.1.4");
    const app = makeApp({ server, authPassword: "hunter2", hostPort: 10060 });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    expect(cfg.http.services[`app-${app.name}`].loadBalancer.servers).toEqual([
      { url: `http://10.0.1.4:${authProxyPort(10060)}` },
    ]);
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

  test("sleeping public app routes its domain to the panel service (wake page)", () => {
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
    expect(state.panelHostPort).toBe(3001);
    const cfg = parse(renderDynamicConfig(state, { isPanel: true }));

    const pub = cfg.http.routers[`pub-${app.name}`];
    expect(pub.service).toBe("ocd-panel");
    expect(pub.rule).toBe("Host(`sleepy.example.com`)");
    expect(cfg.http.services["ocd-panel"].loadBalancer.servers).toEqual([
      { url: "http://127.0.0.1:3001" },
    ]);
    // No upstream pool for the sleeping app itself.
    expect(cfg.http.services[`app-${app.name}`]).toBeUndefined();
    expect(cfg.http.routers[`int-${app.name}`]).toBeUndefined();
    // Workers don't render the wake route.
    const worker = parse(renderDynamicConfig(state, { isPanel: false }));
    expect(worker.http?.routers?.[`pub-${app.name}`]).toBeUndefined();
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
    const cfg = parse(renderPanelConfig("panel.example.com", 3001, false));
    expect(cfg.http.routers.panel.rule).toBe("Host(`panel.example.com`)");
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers["panel-web"].entryPoints).toEqual(["web"]);
    expect(cfg.http.services.panel.loadBalancer.servers).toEqual([
      { url: "http://127.0.0.1:3001" },
    ]);
    // nip.io → default self-signed cert
    const nip = parse(renderPanelConfig("1-2-3-4.nip.io", 3001, true));
    expect(nip.http.routers.panel.tls).toEqual({});
  });
});
