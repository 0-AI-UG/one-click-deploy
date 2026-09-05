// Unit tests for proxy-manager: the single-round-trip probe and the readiness
// gate reconcileProxy maintains for the /etc/hosts VIP flip. SSH is mocked;
// probes are scripted to a fully-converged server so the install/compile path
// is never taken.
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

import * as db from "../../shared/db.ts";
import {
  probeServerProxy,
  reconcileProxy,
  desiredProxyVersion,
  isSupersededProxyBinary,
  isProxyReady,
  type ServerAccess,
} from "./proxy-manager.ts";

test("proxy cache cleanup only targets versioned binaries from old revisions", () => {
  expect(isSupersededProxyBinary("ocd-proxy-aaaaaaaaaaaa-linux-x64", "bbbbbbbbbbbb")).toBe(true);
  expect(isSupersededProxyBinary("ocd-proxy-bbbbbbbbbbbb-linux-arm64", "bbbbbbbbbbbb")).toBe(false);
  expect(isSupersededProxyBinary("operator-backup", "bbbbbbbbbbbb")).toBe(false);
});

function makeServer(ipv4: string, routingAddress: string) {
  return db.insertServer({
    name: `srv-pm-${randomSuffix()}`,
    provider_id: `h-pm-${randomSuffix()}`,
    ipv4,
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    routing_address: routingAddress,
  });
}

function access(ipv4: string): ServerAccess {
  return { name: `host-${ipv4}`, ipv4, hostKey: undefined };
}

beforeEach(() => {
  sshExec.mockClear();
  sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

describe("probeServerProxy", () => {
  test("parses arch|version|active|unitSha|configSha from the probe line", async () => {
    sshExec.mockImplementation(async () => ({
      exitCode: 0,
      stdout: "x86_64|abc123def456|active|unit-sha|config-sha\n",
      stderr: "",
    }));
    const probe = await probeServerProxy(access("198.51.100.70"));
    // toMatchObject (not toEqual) so a fix adding fields stays compatible.
    expect(probe).toMatchObject({
      arch: "x86_64",
      version: "abc123def456",
      active: "active",
      unitSha: "unit-sha",
      configSha: "config-sha",
    });
  });

  test("throws when the probe command fails", async () => {
    sshExec.mockImplementation(async () => ({ exitCode: 1, stdout: "", stderr: "ssh dead" }));
    await expect(probeServerProxy(access("198.51.100.71"))).rejects.toThrow(/probe failed/);
  });
});

describe("contract: P5 probeServerProxy consults the proxy /status endpoint", () => {
  // REGRESSION: currently failing by design — convergence trusts unit state +
  // binary version + file shas alone; a proxy that is 'active' but has not
  // applied its NAT ruleset or bound its VIP listeners still counts as ready.
  // Contract: convergence additionally fetches the proxy's local status
  // endpoint  http://127.0.0.1:18791/status  over the existing sshExec seam
  // (either folded into the probe round trip or as its own sshExec call — the
  // executed command string must contain "127.0.0.1:18791/status") and treats
  // the JSON body {ok: boolean, ...} as authoritative: only ok=true
  // (natApplied && all listeners bound) yields isProxyReady() = true.
  test("status.ok=false → server is NOT marked proxy-ready despite a clean probe", async () => {
    const target = "198.51.100.72";
    makeServer(target, "10.0.72.2");
    const version = await desiredProxyVersion();
    const statusJson = (host: string) =>
      host === target
        ? '{"ok":false,"natApplied":false,"listenersBound":0}'
        : '{"ok":true,"natApplied":true,"listenersBound":1}';

    sshExec.mockImplementation(async (host: string, cmd: string, _hostKey?: string) => {
      const wantsStatus = cmd.includes("127.0.0.1:18791/status");
      if (cmd.includes("--version") && cmd.includes("is-active ocd-proxy")) {
        // Combined probe: append the status JSON as an extra |-field when the
        // probe command fetches it.
        const base = `x86_64|${version}|active|x|y`;
        return {
          exitCode: 0,
          stdout: wantsStatus ? `${base}|${statusJson(host)}` : base,
          stderr: "",
        };
      }
      if (wantsStatus) {
        // Standalone status fetch (e.g. curl in its own round trip).
        return { exitCode: 0, stdout: statusJson(host), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await reconcileProxy();

    const statusFetched = (sshExec.mock.calls as unknown as Array<[string, string]>).some(
      ([host, cmd]) => host === target && cmd.includes("127.0.0.1:18791/status"),
    );
    expect(statusFetched).toBe(true);
    expect(isProxyReady(target)).toBe(false);
  });
});
