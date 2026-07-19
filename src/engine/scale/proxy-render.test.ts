import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import { VIP_RANGE } from "../../shared/db/apps.ts";
import { collectDesiredState, type DesiredState } from "./traefik-render.ts";
import {
  appHostsLine,
  listenerPorts,
  renderProxyConfig,
  renderProxyConfigJson,
} from "./proxy-render.ts";
import {
  PROXY_BIN_PATH,
  PROXY_CONFIG_PATH,
  proxyInstallScript,
  proxySystemdUnit,
} from "./proxy-provision.ts";

// Fixtures in the style of traefik-config.test.ts — the db module (and its
// temp data dir) is shared across all test files, so names are unique and
// assertions select their own slice of the render.

function makeServer(privateIpv4 = `10.0.7.${Math.floor(Math.random() * 200) + 2}`) {
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
  containerPort?: number;
  internalProtocol?: "http" | "tcp";
  replicaStatus?: string | null; // null = no replica at all
  hostPort?: number;
  status?: string;
}) {
  const name = `app-${randomSuffix()}`;
  const app = db.insertApp({
    name,
    domain: "",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: opts.containerPort ?? 3000,
    env_vars: "{}",
    public: false,
    health_check: true,
    internal_protocol: opts.internalProtocol,
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

function stateFor(...appNames: string[]): DesiredState {
  const state = collectDesiredState();
  return {
    ...state,
    apps: state.apps.filter((a) => appNames.includes(a.name)),
    services: [],
  };
}

describe("listenerPorts", () => {
  test("http app: internal_port + container_port + 80, sorted", () => {
    expect(
      listenerPorts({ internalPort: 20005, containerPort: 3000, internalProtocol: "http" }),
    ).toEqual([80, 3000, 20005]);
  });

  test("tcp app: no :80 listener", () => {
    expect(
      listenerPorts({ internalPort: 20005, containerPort: 5432, internalProtocol: "tcp" }),
    ).toEqual([5432, 20005]);
  });

  test("dedupe: container_port 80 on an http app collapses into the :80 listener", () => {
    expect(
      listenerPorts({ internalPort: 20005, containerPort: 80, internalProtocol: "http" }),
    ).toEqual([80, 20005]);
  });

  test("dedupe: container_port equal to internal_port renders once", () => {
    expect(
      listenerPorts({ internalPort: 20005, containerPort: 20005, internalProtocol: "tcp" }),
    ).toEqual([20005]);
    expect(
      listenerPorts({ internalPort: 20005, containerPort: 20005, internalProtocol: "http" }),
    ).toEqual([80, 20005]);
  });
});

describe("renderProxyConfig", () => {
  test("app entry: vip from the allocator, all-tcp listeners, backends = upstream pool", () => {
    const server = makeServer("10.0.7.10");
    const app = makeApp({ server, containerPort: 3000, hostPort: 10201 });
    expect(app.virtual_ip).toMatch(/^10\.96\.\d+\.\d+$/);

    const cfg = renderProxyConfig(stateFor(app.name));
    expect(cfg.version).toBe(1);
    expect(cfg.apps).toHaveLength(1);
    const entry = cfg.apps[0]!;
    expect(entry.appId).toBe(app.id);
    expect(entry.name).toBe(app.name);
    expect(entry.vip).toBe(app.virtual_ip);
    expect(entry.sleeping).toBe(false);
    expect(entry.backends).toEqual(["10.0.7.10:10201"]);
    expect(entry.listeners).toEqual([
      { port: 80, protocol: "tcp" },
      { port: 3000, protocol: "tcp" },
      { port: app.internal_port, protocol: "tcp" },
    ]);
  });

  test("tcp-routed app gets no :80 listener", () => {
    const server = makeServer("10.0.7.11");
    const app = makeApp({ server, internalProtocol: "tcp", containerPort: 5432, hostPort: 10202 });
    const cfg = renderProxyConfig(stateFor(app.name));
    expect(cfg.apps[0]!.listeners).toEqual([
      { port: 5432, protocol: "tcp" },
      { port: app.internal_port, protocol: "tcp" },
    ]);
  });

  test("sleeping app: sleeping=true with empty backends (stopped anchor is not servable)", () => {
    const server = makeServer("10.0.7.12");
    const app = makeApp({ server, replicaStatus: "stopped", status: "sleeping", hostPort: 10203 });
    const cfg = renderProxyConfig(stateFor(app.name));
    expect(cfg.apps[0]!.sleeping).toBe(true);
    expect(cfg.apps[0]!.backends).toEqual([]);
  });

  test("apps without a virtual_ip are skipped (nothing to bind)", () => {
    const server = makeServer("10.0.7.13");
    const app = makeApp({ server, hostPort: 10204 });
    const state = stateFor(app.name);
    state.apps = state.apps.map((a) => ({ ...a, virtualIp: "" }));
    const cfg = renderProxyConfig(state);
    expect(cfg.apps).toEqual([]);
  });

  test("wakeUrl targets the panel's published host port on its private IP; null without either", () => {
    const server = makeServer("10.0.7.14");
    const app = makeApp({ server, hostPort: 10205 });
    const state = stateFor(app.name);

    const withPanel = renderProxyConfig({
      ...state,
      panelPrivateIpv4: "10.0.7.99",
      panelHostPort: 10001,
    });
    expect(withPanel.wakeUrl).toBe("http://10.0.7.99:10001/api/internal/wake");

    const noPanel = renderProxyConfig({ ...state, panelPrivateIpv4: null });
    expect(noPanel.wakeUrl).toBeNull();

    const noPort = renderProxyConfig({
      ...state,
      panelPrivateIpv4: "10.0.7.99",
      panelHostPort: null,
    });
    expect(noPort.wakeUrl).toBeNull();
  });

  test("wakeSecret: created once (32 bytes hex), persisted, stable across renders", () => {
    const server = makeServer("10.0.7.15");
    const app = makeApp({ server, hostPort: 10206 });
    const state = stateFor(app.name);
    const first = renderProxyConfig(state);
    expect(first.wakeSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(db.getSettings()["proxy_wake_secret"]).toBe(first.wakeSecret);
    expect(renderProxyConfig(state).wakeSecret).toBe(first.wakeSecret);
  });

  test("deterministic output: byte-identical renders, apps sorted by name", () => {
    const server = makeServer("10.0.7.16");
    const b = makeApp({ server, hostPort: 10207 });
    const a = makeApp({ server, hostPort: 10208 });
    const state = stateFor(a.name, b.name);
    // Shuffle the snapshot's order — the renderer must re-sort.
    const shuffled = { ...state, apps: [...state.apps].reverse() };
    const first = renderProxyConfigJson(state);
    const second = renderProxyConfigJson(shuffled);
    expect(first).toBe(second);
    const names = renderProxyConfig(state).apps.map((x) => x.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("appHostsLine (VIP gating for /etc/hosts)", () => {
  const app = { name: "shop", virtual_ip: "10.96.0.7" };

  test("proxy confirmed live → VIP line", () => {
    expect(appHostsLine(app, "10.0.0.5", true)).toBe("10.96.0.7 shop.ocd.internal");
  });

  test("proxy not (yet) ready → local private-IP line", () => {
    expect(appHostsLine(app, "10.0.0.5", false)).toBe("10.0.0.5 shop.ocd.internal");
  });

  test("no VIP allocated → private-IP line even with a live proxy", () => {
    expect(appHostsLine({ name: "old", virtual_ip: "" }, "10.0.0.5", true)).toBe(
      "10.0.0.5 old.ocd.internal",
    );
  });
});

describe("proxy provisioning", () => {
  test("systemd unit: local VIP route on loopback via ExecStartPre, Restart=always", () => {
    const unit = proxySystemdUnit();
    expect(unit).toContain(`ExecStartPre=/usr/sbin/ip route replace local ${VIP_RANGE} dev lo`);
    expect(unit).toContain(`ExecStart=${PROXY_BIN_PATH} --config ${PROXY_CONFIG_PATH}`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("After=network-online.target");
  });

  test("install script: verifies sha + version, installs, writes the unit, restarts, verifies active", () => {
    const script = proxyInstallScript("/tmp/.ocd-proxy.abc", {
      sha256: "f00d".repeat(16),
      version: "abcdef123456",
    });
    expect(script).toContain(`echo "${"f00d".repeat(16)}  /tmp/.ocd-proxy.abc" | sha256sum -c -`);
    expect(script).toContain('V=$(/tmp/.ocd-proxy.abc --version)');
    expect(script).toContain('[ "$V" = "abcdef123456" ]');
    expect(script).toContain(`install -m 755 /tmp/.ocd-proxy.abc ${PROXY_BIN_PATH}`);
    expect(script).toContain("mkdir -p /etc/ocd-proxy");
    // Settle past one Restart=always cycle so is-active can't catch the
    // transient "active" of a binary that dies on boot.
    expect(script).toContain("sleep 3\nsystemctl is-active ocd-proxy");
    expect(script).toContain(proxySystemdUnit());
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("systemctl enable ocd-proxy");
    expect(script).toContain("systemctl restart ocd-proxy");
    expect(script).toContain("systemctl is-active ocd-proxy");
    // The config (and its wake secret) is never written by the install script
    // — it ships separately with mode 600.
    expect(script).not.toContain("wakeSecret");
  });
});
