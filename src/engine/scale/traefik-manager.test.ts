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
import { saveSetting } from "../../shared/db/settings.ts";
import {
  convergeServerTraefik,
  reconcilePanelSite,
  type ServerAccess,
} from "./traefik-manager.ts";
import {
  collectDesiredState,
  renderDynamicConfig,
  renderPanelConfig,
  traefikStaticConfig,
  traefikSystemdUnit,
  TRAEFIK_ENV_PATH,
  TRAEFIK_PANEL_CONFIG_PATH,
  TRAEFIK_VERSION,
} from "./traefik-config.ts";

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
      git_repo: "https://x.git",
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
      git_repo: "https://x.git",
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

describe("convergeServerTraefik ACME env file convergence", () => {
  // sha of a remote file as probeServerTraefik reports it (content + the
  // trailing newline every writer appends).
  function remoteSha(content: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content + "\n");
    return hasher.digest("hex");
  }

  function access(ipv4: string): ServerAccess {
    return { name: `host-${ipv4}`, ipv4, hostKey: undefined };
  }

  /** Answer probes with an in-sync server (binary, static, unit, dynamic,
   *  panel.yml all converged) whose env file has the given sha — so the env
   *  file is the only thing left to converge. */
  function probeImplementation(panelIp: string, envShaByHost: Record<string, string>) {
    return async (host: string, cmd: string, _hostKey?: string) => {
      if (cmd.includes("systemctl is-active")) {
        const state = collectDesiredState();
        const dynSha = remoteSha(renderDynamicConfig(state, { isPanel: host === panelIp }));
        const panel = getPanel();
        const panelSha =
          host === panelIp && panel
            ? remoteSha(renderPanelConfig(panel.domain, panel.host_port, state.zoneName))
            : "";
        const staticSha = remoteSha(traefikStaticConfig());
        const unitSha = remoteSha(traefikSystemdUnit());
        const line = `${TRAEFIK_VERSION}|active|${staticSha}|${unitSha}|${dynSha}|${panelSha}|${envShaByHost[host] ?? ""}`;
        return { exitCode: 0, stdout: line, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
  }

  function envWrites(): Array<[string, string]> {
    return (sshExec.mock.calls as unknown as Array<[string, string]>).filter(
      ([, cmd]) => cmd.includes("printf") && cmd.includes(TRAEFIK_ENV_PATH),
    );
  }

  function expectedFor(panelEnv: string) {
    return { panelEnv };
  }

  test("delivers the token to the panel server only (chmod 600) and restarts it; steady state writes nothing", async () => {
    const panelSrv = makePanelServer("198.51.100.20");
    insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.zone-test.dev",
      git_repo: "https://x.git",
      container_port: 3001,
      host_port: 3001,
    });
    saveSetting("dns_zone_name", "zone-test.dev");
    const expectedEnv = "HETZNER_API_KEY=test-token-123";

    try {
      // Env file missing everywhere → panel gets it, worker does not.
      sshExec.mockImplementation(probeImplementation("198.51.100.20", {}));
      const state = collectDesiredState();
      await convergeServerTraefik(access("198.51.100.20"), state, expectedFor(expectedEnv));
      await convergeServerTraefik(access("198.51.100.21"), state, expectedFor(expectedEnv));

      const writes = envWrites();
      expect(writes).toHaveLength(1);
      const [host, cmd] = writes[0];
      expect(host).toBe("198.51.100.20");
      expect(cmd).toContain(expectedEnv);
      expect(cmd).toContain("chmod 600");
      // Env file feeds the systemd unit → its change restarts the service.
      const restarts = (sshExec.mock.calls as unknown as Array<[string, string]>).filter(
        ([, c]) => c.includes("systemctl restart ocd-traefik"),
      );
      expect(restarts).toHaveLength(1);
      expect(restarts[0][0]).toBe("198.51.100.20");

      // Steady state: probe reports the delivered env file → no write, no restart.
      sshExec.mockClear();
      sshExec.mockImplementation(
        probeImplementation("198.51.100.20", { "198.51.100.20": remoteSha(expectedEnv) }),
      );
      await convergeServerTraefik(access("198.51.100.20"), state, expectedFor(expectedEnv));
      expect(envWrites()).toHaveLength(0);
      expect(
        (sshExec.mock.calls as unknown as Array<[string, string]>).some(([, c]) =>
          c.includes("systemctl restart"),
        ),
      ).toBe(false);
    } finally {
      saveSetting("dns_zone_name", "");
      sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    }
  });

  test("empty expected env (no zone / no token) → env file is left unmanaged", async () => {
    const panelSrv = makePanelServer("198.51.100.30");
    insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      git_repo: "https://x.git",
      container_port: 3001,
      host_port: 3001,
    });
    try {
      sshExec.mockImplementation(probeImplementation("198.51.100.30", {}));
      await convergeServerTraefik(access("198.51.100.30"), collectDesiredState(), expectedFor(""));
      expect(envWrites()).toHaveLength(0);
    } finally {
      sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    }
  });
});
