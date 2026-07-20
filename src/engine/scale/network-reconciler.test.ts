// Unit tests for syncInternalHosts(): the /etc/hosts rendering that maps
// `<app>.ocd.internal` names to per-app VIPs, gated on each server's ocd-proxy
// readiness (proxy-manager convergence). SSH is mocked; readiness is driven
// through reconcileProxy() with a scripted probe so the real gate is exercised.
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// mock.module factories must cover the COMPLETE export surface of the mocked
// module (Bun module namespaces are sealed — a later re-mock in another test
// file cannot add slots this factory omits). Spread the real namespace and
// override only what these tests stub.
import * as realRemote from "../../shared/remote/index.ts";

const sshExec = mock(async (_host: string, _cmd: string, _hostKey?: string) => {
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../shared/remote/index.ts", () => ({
  ...realRemote,
  sshExec,
  getSshKeyPath: () => "/tmp/test-key",
  healthCheck: mock(async () => ({ healthy: true })),
}));

import rawDb from "../../shared/db/connection.ts";
import * as db from "../../shared/db.ts";
import { insertPanel } from "../../shared/db/panel.ts";
import { syncInternalHosts } from "./network-reconciler.ts";
import { reconcileProxy, desiredProxyVersion, isProxyReady } from "./proxy-manager.ts";

function makeServer(ipv4: string, privateIpv4: string) {
  return db.insertServer({
    name: `srv-nr-${randomSuffix()}`,
    provider_id: `h-nr-${randomSuffix()}`,
    ipv4,
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    private_ipv4: privateIpv4,
  });
}

function makeAppOn(server: { id: number }, hostPort: number) {
  const app = db.insertApp({
    name: `nr-app-${randomSuffix()}`,
    domain: "",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
  db.insertReplica({
    app_id: app.id,
    server_id: server.id,
    host_port: hostPort,
    container_name: app.name,
    status: "running",
  });
  return db.getApp(app.id)!;
}

/** syncInternalHosts is a no-op without a panel row — (re)create the
 *  singleton against a dedicated panel server. */
function ensurePanel() {
  rawDb.query("DELETE FROM panel").run();
  const server = makeServer(`198.51.100.${200 + Math.floor(Math.random() * 50)}`, "10.0.99.2");
  insertPanel({
    server_id: server.id,
    name: "ocd-panel",
    domain: "panel.example.com",
    git_repo: "https://x.git",
    container_port: 3001,
    host_port: 3001,
  });
}

/** Answer proxy probes with a fully-converged server (current version,
 *  active unit) so reconcileProxy never hits the install/compile path.
 *  Hosts in `failHosts` get a failing probe → convergence failure. */
async function scriptProbes(failHosts: string[] = []) {
  const version = await desiredProxyVersion();
  sshExec.mockImplementation(async (host: string, cmd: string, _hostKey?: string) => {
    if (cmd.includes("--version") && cmd.includes("is-active ocd-proxy")) {
      if (failHosts.includes(host)) {
        return { exitCode: 1, stdout: "", stderr: "probe failed (test)" };
      }
      return { exitCode: 0, stdout: `x86_64|${version}|active|x|y`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

/** The most recent /etc/hosts block written to a server, or null. */
function hostsBlockFor(ipv4: string): string | null {
  const writes = (sshExec.mock.calls as unknown as Array<[string, string]>).filter(
    ([host, cmd]) => host === ipv4 && cmd.includes("/etc/hosts"),
  );
  return writes.length ? writes[writes.length - 1][1] : null;
}

beforeEach(() => {
  sshExec.mockClear();
  sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

describe("syncInternalHosts (VIP hosts lines)", () => {
  test("converged server: app hosts lines map names to the app VIPs", async () => {
    ensurePanel();
    const server = makeServer("198.51.100.61", "10.0.61.2");
    const app = makeAppOn(server, 10611);
    expect(app.virtual_ip).toMatch(/^10\.96\.\d+\.\d+$/);

    await scriptProbes();
    await reconcileProxy();
    expect(isProxyReady("198.51.100.61")).toBe(true);

    sshExec.mockClear();
    await scriptProbes(); // re-arm implementation after mockClear
    await syncInternalHosts();

    const block = hostsBlockFor("198.51.100.61");
    expect(block).not.toBeNull();
    expect(block!).toContain(`${app.virtual_ip} ${app.name}.ocd.internal`);
    // The safe fallback line must not coexist with the VIP line.
    expect(block!).not.toContain(`10.0.61.2 ${app.name}.ocd.internal`);
  });
});

describe("contract: P4 hosts lines are last-known-good, never private-IP fallback", () => {
  // REGRESSION: currently failing by design — syncInternalHosts falls back to
  // `<server-private-ip> <app>.ocd.internal` lines whenever isProxyReady() is
  // false. Contract:
  //   - a server whose proxy NEVER converged gets NO app hosts lines at all
  //     (no legacy private-IP fallback — that IP no longer terminates app
  //     traffic since the port-based internal ingress teardown);
  //   - a server whose converge FAILS after a previous success KEEPS the
  //     previously-rendered VIP lines (last-known-good) instead of rewriting
  //     them to fallback lines.
  // Suggested seam for the fix: proxy-manager exports
  //   wasProxyEverReady(ipv4: string): boolean
  // and appHostsLine(app, serverPrivateIpv4, readiness) returns string | null
  // (null = emit nothing for this app on this server).

  test("never-converged server gets NO app hosts lines (no private-IP fallback)", async () => {
    ensurePanel();
    const server = makeServer("198.51.100.62", "10.0.62.2");
    const app = makeAppOn(server, 10621);

    // No reconcileProxy() for this server — its proxy was never proven live.
    expect(isProxyReady("198.51.100.62")).toBe(false);
    await syncInternalHosts();

    const block = hostsBlockFor("198.51.100.62");
    expect(block).not.toBeNull();
    expect(block!).not.toContain(`${app.name}.ocd.internal`);
  });

  test("converge failure after a previous success keeps the VIP lines (last-known-good)", async () => {
    ensurePanel();
    const server = makeServer("198.51.100.63", "10.0.63.2");
    const app = makeAppOn(server, 10631);

    // Phase 1: healthy converge → VIP lines (sanity; passes today).
    await scriptProbes();
    await reconcileProxy();
    await syncInternalHosts();
    expect(hostsBlockFor("198.51.100.63")!).toContain(
      `${app.virtual_ip} ${app.name}.ocd.internal`,
    );

    // Phase 2: this server's converge now fails.
    sshExec.mockClear();
    await scriptProbes(["198.51.100.63"]);
    await reconcileProxy();
    await syncInternalHosts();

    const block = hostsBlockFor("198.51.100.63");
    expect(block).not.toBeNull();
    // Last-known-good: still the VIP line, not the private-IP fallback.
    expect(block!).toContain(`${app.virtual_ip} ${app.name}.ocd.internal`);
    expect(block!).not.toContain(`10.0.63.2 ${app.name}.ocd.internal`);
  });
});
