// Unit tests for reconcilePanelSite(): the reconciler-owned drift repair of
// the panel's own vhost (panel.yml). ocd.yml rendering is covered by
// traefik-config.test.ts; here we only verify write/skip behavior over the
// mocked SSH boundary.
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

const sshExec = mock(async (_host: string, _cmd: string, _hostKey?: string) => {
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../shared/remote/index.ts", () => ({
  sshExec,
  healthCheck: mock(async () => ({ healthy: true })),
}));

import rawDb from "../../shared/db/connection.ts";
import { insertServer } from "../../shared/db/servers.ts";
import { insertPanel, getPanel } from "../../shared/db/panel.ts";
import {
  reconcilePanelSite,
  reconcileWorkerTeardown,
} from "./traefik-manager.ts";
import {
  TRAEFIK_PANEL_CONFIG_PATH,
} from "./traefik-constants.ts";

function makePanelServer(ipv4: string) {
  return insertServer({
    name: `srv-panel-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    provider_id: `h-${Date.now()}-${Math.random()}`,
    ipv4,
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

beforeEach(() => {
  sshExec.mockClear();
  rawDb.query("DELETE FROM panel").run();
});

describe("reconcilePanelSite", () => {
  test("no panel row → no SSH traffic", async () => {
    expect(getPanel()).toBeNull();
    await reconcilePanelSite();
    expect(sshExec).not.toHaveBeenCalled();
  });

  test("writes panel.yml with the panel's domain, then skips unchanged re-runs", async () => {
    const server = makePanelServer("203.0.113.10");
    insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001,
      host_port: 3001,
    });

    await reconcilePanelSite();
    expect(sshExec).toHaveBeenCalledTimes(1);
    const [host, cmd] = sshExec.mock.calls[0] as unknown as [string, string];
    expect(host).toBe("203.0.113.10");
    expect(cmd).toContain(TRAEFIK_PANEL_CONFIG_PATH);
    expect(cmd).toContain("panel.example.com");

    // Steady state: identical content is content-hash-skipped.
    await reconcilePanelSite();
    expect(sshExec).toHaveBeenCalledTimes(1);
  });

  test("rewrites when the panel domain changes", async () => {
    const server = makePanelServer("203.0.113.11");
    insertPanel({
      server_id: server.id,
      name: "ocd-panel",
      domain: "old.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001,
      host_port: 3001,
    });
    await reconcilePanelSite();
    expect(sshExec).toHaveBeenCalledTimes(1);

    rawDb.query("UPDATE panel SET domain = ? WHERE id = 1").run("new.example.com");
    await reconcilePanelSite();
    expect(sshExec).toHaveBeenCalledTimes(2);
    const [, cmd] = sshExec.mock.calls[1] as unknown as [string, string];
    expect(cmd).toContain("new.example.com");
  });
});

describe("reconcileTraefik worker teardown", () => {
  function disableCalls(): Array<[string, string]> {
    return (sshExec.mock.calls as unknown as Array<[string, string]>).filter(
      ([, cmd]) => cmd.includes("disable --now ocd-traefik"),
    );
  }

  test("stops+disables ocd-traefik on non-panel servers, never on the panel", async () => {
    const panelSrv = makePanelServer("192.0.2.40");
    makePanelServer("192.0.2.41"); // a ready worker
    insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3001,
      host_port: 3001,
    });

    await reconcileWorkerTeardown();

    const disables = disableCalls();
    // The worker got a teardown; the panel never does.
    expect(disables.some(([host]) => host === "192.0.2.41")).toBe(true);
    expect(disables.some(([host]) => host === "192.0.2.40")).toBe(false);
    // Every teardown call is stop+disable only — never deletes binary/config.
    for (const [, cmd] of disables) {
      expect(cmd).toContain("systemctl disable --now ocd-traefik");
    }
  });
});
