import { useTempDataDir, makeFakeComputeProvider, makeFakeDnsProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// All these mocks must be set up BEFORE importing lifecycle.ts so its static
// imports resolve to the mocks.

const compute = makeFakeComputeProvider();
const dns = makeFakeDnsProvider();
mock.module("../../shared/providers/index.ts", () => ({
  hetzner: compute,
  hetznerDns: dns,
}));

const sshExec = mock(async (..._args: unknown[]) => ({ exitCode: 0, stdout: "", stderr: "" }));
const removeContainer = mock(async (..._args: unknown[]) => {});
const removeCompose = mock(async (..._args: unknown[]) => {});
const removeAuthProxy = mock(async (..._args: unknown[]) => {});
mock.module("../../shared/remote/index.ts", () => ({
  sshExec,
  removeContainer,
  removeCompose,
  removeAuthProxy,
  restartContainer: mock(async () => {}),
  pauseContainer: mock(async () => {}),
  unpauseContainer: mock(async () => {}),
  restartCompose: mock(async () => {}),
  pauseCompose: mock(async () => {}),
  unpauseCompose: mock(async () => {}),
  composeHealthCheck: mock(async () => ({ healthy: true })),
  healthCheck: mock(async () => ({ healthy: true })),
  describeFailure: (prefix: string) => prefix,
}));

const removeAppCaddy = mock(async () => {});
const syncAppCaddy = mock(async () => {});
mock.module("../scale/caddy-manager.ts", () => ({
  removeAppCaddy,
  syncAppCaddy,
}));

const deleteGithubWebhook = mock(async (..._args: unknown[]) => {});
const getGitHubPat = mock(async (..._args: unknown[]) => "ghp_fake" as string | null);
mock.module("../../shared/github.ts", () => ({
  getGitHubPat,
  deleteWebhook: deleteGithubWebhook,
}));

import * as db from "../../shared/db.ts";
import rawDb from "../../shared/db.ts";
import { destroyApp, destroyServer } from "./lifecycle.ts";

function freshServer() {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
  });
}

function freshApp(overrides: Partial<{ auth_password: string }> = {}) {
  return db.insertApp({
    name: `app-${randomSuffix()}`,
    domain: "x.example.com",
    git_repo: "https://github.com/x/y",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
    auth_password: overrides.auth_password,
  });
}

function attachReplica(appId: number, serverId: number, name: string) {
  return db.insertReplica({
    app_id: appId,
    server_id: serverId,
    host_port: 10000 + Math.floor(Math.random() * 1000),
    container_name: name,
    status: "running",
  });
}

beforeEach(() => {
  sshExec.mockClear();
  removeContainer.mockClear();
  removeCompose.mockClear();
  removeAuthProxy.mockClear();
  removeAppCaddy.mockClear();
  deleteGithubWebhook.mockClear();
  getGitHubPat.mockClear();
  compute._mocks.volumeDelete.mockClear();
  compute._mocks.deleteServer.mockClear();
  dns._mocks.deleteRecord.mockClear();

  // Restore default successful behaviour (tests override as needed).
  removeContainer.mockImplementation(async () => {});
  removeCompose.mockImplementation(async () => {});
  removeAppCaddy.mockImplementation(async () => {});
  dns._mocks.deleteRecord.mockImplementation(async () => {});
  compute._mocks.volumeDelete.mockImplementation(async () => {});
  sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

describe("destroyApp: happy path", () => {
  test("removes containers, caddy route, DNS records, and DB rows for an app with one replica", async () => {
    const server = freshServer();
    const app = freshApp();
    const replica = attachReplica(app.id, server.id, app.name);
    db.insertDnsRecord({
      app_id: app.id,
      zone_id: "zone-1",
      record_id: "rec-1",
      name: "x",
      type: "A",
      value: "1.2.3.4",
    });

    const result = await destroyApp(app.id);

    expect(result.ok).toBe(true);
    expect(removeContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer.mock.calls[0][0]).toBe("1.2.3.4");
    expect(removeContainer.mock.calls[0][1]).toBe(app.name);
    expect(removeAppCaddy).toHaveBeenCalledTimes(1);
    expect(dns._mocks.deleteRecord).toHaveBeenCalledTimes(1);

    // DB rows gone.
    expect(db.getApp(app.id)).toBeNull();
    expect(db.getReplica(replica.id)).toBeNull();
    expect(db.getDnsRecords(app.id)).toEqual([]);
  });

  test("returns ok:false when the app does not exist", async () => {
    const result = await destroyApp(999_999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test("skips auth-proxy removal when auth_password is not set", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    await destroyApp(app.id);
    expect(removeAuthProxy).not.toHaveBeenCalled();
  });

  test("removes auth proxy for each replica when auth_password is set", async () => {
    const server = freshServer();
    const app = freshApp({ auth_password: "$2b$fakehash" });
    attachReplica(app.id, server.id, app.name);
    attachReplica(app.id, server.id, app.name + "-r2");
    await destroyApp(app.id);
    expect(removeAuthProxy).toHaveBeenCalledTimes(2);
  });

  test("uses removeCompose path when deploy_mode is 'compose' and replica is primary", async () => {
    const server = freshServer();
    const app = freshApp();
    rawDb.query("UPDATE apps SET deploy_mode=?, compose_file=? WHERE id=?").run("compose", "docker-compose.yml", app.id);
    attachReplica(app.id, server.id, app.name); // container_name === app.name → primary
    await destroyApp(app.id);
    expect(removeCompose).toHaveBeenCalledTimes(1);
    expect(removeContainer).not.toHaveBeenCalled();
  });

  test("invokes GitHub webhook deletion when webhook was enabled", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppWebhook(app.id, true, "wh-secret", "main", "123");
    await destroyApp(app.id);
    expect(getGitHubPat).toHaveBeenCalled();
    expect(deleteGithubWebhook).toHaveBeenCalledTimes(1);
    expect(deleteGithubWebhook.mock.calls[0][0]).toMatchObject({ webhookId: "123" });
  });

  test("skips GitHub webhook call when no PAT is available", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppWebhook(app.id, true, "wh", "main", "456");
    getGitHubPat.mockImplementationOnce(async () => null);
    await destroyApp(app.id);
    expect(deleteGithubWebhook).not.toHaveBeenCalled();
  });
});

describe("destroyApp: volume cleanup", () => {
  test("deletes the associated volume when volume_id is set", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppVolume(app.id, "vol-abc", "/data");

    await destroyApp(app.id);

    expect(compute._mocks.volumeDelete).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDelete.mock.calls[0][0]).toBe("vol-abc");
  });

  test("does not call volume delete when no volume attached", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    await destroyApp(app.id);
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
  });
});

describe("destroyApp: partial failure handling", () => {
  test("marks app as cleanup_failed when DNS deletion fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.insertDnsRecord({
      app_id: app.id,
      zone_id: "z",
      record_id: "r",
      name: "x",
      type: "A",
      value: "1",
    });
    dns._mocks.deleteRecord.mockImplementationOnce(async () => {
      throw new Error("dns boom");
    });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cleanup/i);
    // App row NOT deleted on failure — so user can retry.
    const appRow = db.getApp(app.id);
    expect(appRow).not.toBeNull();
    expect(appRow?.status).toBe("cleanup_failed");
  });

  test("marks app cleanup_failed when a container removal fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    removeContainer.mockImplementationOnce(async () => { throw new Error("ssh down"); });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(false);
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });

  test("marks app cleanup_failed when volume deletion fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppVolume(app.id, "vol-err", "/data");
    compute._mocks.volumeDelete.mockImplementationOnce(async () => { throw new Error("still attached"); });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(false);
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });

  test("Caddy removal failure is logged but does NOT mark cleanup_failed", async () => {
    // The lifecycle code tolerates Caddy failures without setting cleanupFailed.
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    removeAppCaddy.mockImplementationOnce(async () => { throw new Error("caddy 503"); });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(true);
    expect(db.getApp(app.id)).toBeNull();
  });
});

describe("destroyApp: multi-server GC", () => {
  test("iterates all servers that hosted replicas and GC-attempts each", async () => {
    const s1 = freshServer();
    const s2 = freshServer();
    const app = freshApp();
    attachReplica(app.id, s1.id, app.name);
    attachReplica(app.id, s2.id, `${app.name}-r2`);

    // Spy on gcServerIfEmpty indirectly: after destroy, the (now-empty)
    // servers should be deleted because no replicas remain and they are not
    // the panel.
    db.deletePanel();
    await destroyApp(app.id);

    // Both servers gone, because each became empty and the mocked provider's
    // deleteServer succeeds.
    expect(db.getServer(s1.id)).toBeFalsy();
    expect(db.getServer(s2.id)).toBeFalsy();
    expect(compute._mocks.deleteServer).toHaveBeenCalledTimes(2);
  });

  test("does NOT delete the panel's own server, even when it becomes empty", async () => {
    const panelSrv = freshServer();
    db.deletePanel();
    db.insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      git_repo: "https://github.com/x/one-click-deploy",
      container_port: 3001,
      host_port: 3001,
    });
    const app = freshApp();
    attachReplica(app.id, panelSrv.id, app.name);

    await destroyApp(app.id);

    expect(db.getServer(panelSrv.id)).toBeTruthy();
    expect(compute._mocks.deleteServer).not.toHaveBeenCalled();
    db.deletePanel();
  });
});

describe("destroyServer", () => {
  beforeEach(() => {
    db.deletePanel();
  });

  test("destroys server with no apps — calls provider deleteServer and removes DB row", async () => {
    const server = freshServer();
    const result = await destroyServer(server.id);
    expect(result.ok).toBe(true);
    expect(compute._mocks.deleteServer).toHaveBeenCalledTimes(1);
    expect(compute._mocks.deleteServer.mock.calls[0][0]).toBe(server.provider_id);
    expect(db.getServer(server.id)).toBeFalsy();
  });

  test("refuses to destroy the panel's server", async () => {
    const panelSrv = freshServer();
    db.insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      git_repo: "https://github.com/x/one-click-deploy",
      container_port: 3001,
      host_port: 3001,
    });

    const result = await destroyServer(panelSrv.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/panel/i);
    expect(compute._mocks.deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(panelSrv.id)).toBeTruthy();
    db.deletePanel();
  });

  test("destroys all apps on the server before deleting the server", async () => {
    const server = freshServer();
    const appA = freshApp();
    const appB = freshApp();
    attachReplica(appA.id, server.id, appA.name);
    attachReplica(appB.id, server.id, appB.name);

    const result = await destroyServer(server.id);

    expect(result.ok).toBe(true);
    // Two app containers + server itself removed.
    expect(removeContainer).toHaveBeenCalledTimes(2);
    expect(db.getApp(appA.id)).toBeNull();
    expect(db.getApp(appB.id)).toBeNull();
    expect(db.getServer(server.id)).toBeFalsy();
  });

  test("returns error for unknown server id", async () => {
    const result = await destroyServer(999_999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
