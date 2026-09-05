import { useTempDataDir, makeFakeComputeProvider, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// All these mocks must be set up BEFORE importing lifecycle.ts so its static
// imports resolve to the mocks.

const compute = makeFakeComputeProvider();

const sshExec = mock(async (..._args: unknown[]) => ({ exitCode: 0, stdout: "", stderr: "" }));
const removeContainer = mock(async (..._args: unknown[]) => {});
mock.module("../../shared/remote/index.ts", () => ({
  sshExec,
  removeContainer,
  restartContainer: mock(async () => {}),
  pauseContainer: mock(async () => {}),
  unpauseContainer: mock(async () => {}),
  healthCheck: mock(async () => ({ healthy: true })),
  describeFailure: (prefix: string) => prefix,
}));

const syncAllTraefik = mock(async () => {});
const syncAppIngress = mock(async () => {});
mock.module("../scale/traefik-manager.ts", () => ({
  syncAllTraefik,
  syncAppIngress,
  getPanelIngressIpv4: mock(() => null),
  reconcileTraefik: mock(async () => {}),
}));

const deleteGithubWebhook = mock(async (..._args: unknown[]) => {});
const getGitHubPat = mock(async (..._args: unknown[]) => "ghp_fake" as string | null);
mock.module("../../shared/github.ts", () => ({
  getGitHubPat,
  deleteWebhook: deleteGithubWebhook,
}));

import * as db from "../../shared/db.ts";
import { __replaceInfrastructureProvidersForTest } from "../../shared/providers/registry.ts";
import { destroyApp } from "./lifecycle.ts";
import { enqueueOperation, listChildOperations, markOperationFinished } from "../../shared/db/operations.ts";
import destroyServerOp from "../ops/destroy-server.ts";

// destroyServer() (the imperative lifecycle helper) was removed; the destroy
// server flow now lives in the destroy_server op. Drive that op end-to-end with
// a synthetic context, mirroring how the engine executor runs its steps in
// order. Best-effort steps swallow their own errors; only `preflight` throws,
// which maps to ok:false here.
async function destroyServer(serverId: number): Promise<{ ok: boolean; error?: string }> {
  const parent = enqueueOperation({
    kind: "destroy_server",
    resourceKeys: [`server:${serverId}`],
    input: { serverId },
    trigger: "test",
  });
  const ctx = {
    opId: parent.id,
    kind: "destroy_server",
    input: { serverId },
    trigger: "user" as const,
    triggeredBy: "",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  } as any;
  const prior: Record<string, unknown> = {};
  try {
    for (const step of destroyServerOp.steps) {
      const running = step.run(ctx, prior);
      if (step.name === "destroy_apps_on_server") {
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const child of listChildOperations(ctx.opId).filter((op) => op.status === "pending")) {
          const input = JSON.parse(child.input_json) as { appId?: number };
          const result = await destroyApp(input.appId!);
          markOperationFinished(
            child.id,
            result.ok ? "done" : "failed",
            result.ok ? undefined : { message: result.error || "child destroy failed" },
          );
        }
      }
      prior[step.name] = await running;
    }
    markOperationFinished(parent.id, "done");
    return { ok: true };
  } catch (err) {
    markOperationFinished(parent.id, "failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function freshServer() {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    provider: "hetzner",
    ownership: "managed",
  });
}

function freshConnectedServer() {
  return db.insertServer({
    name: `connected-${randomSuffix()}`,
    provider_id: "",
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "external",
    location: "external",
    status: "ready",
    provider: "",
    ownership: "connected",
  });
}

function freshApp() {
  return db.insertApp({
    name: `app-${randomSuffix()}`,
    domain: "x.example.com",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
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
  __replaceInfrastructureProvidersForTest([compute]);
  sshExec.mockClear();
  removeContainer.mockClear();
  syncAllTraefik.mockClear();
  deleteGithubWebhook.mockClear();
  getGitHubPat.mockClear();
  compute._mocks.volumeDelete.mockClear();
  compute._mocks.volumeDetach.mockClear();
  compute._mocks.deleteServer.mockClear();

  // Restore default successful behaviour (tests override as needed).
  removeContainer.mockImplementation(async () => {});
  syncAllTraefik.mockImplementation(async () => {});
  compute._mocks.volumeDelete.mockImplementation(async () => {});
  compute._mocks.volumeDetach.mockImplementation(async () => {});
  sshExec.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

describe("destroyApp: happy path", () => {
  test("removes containers, ingress route, and DB rows while leaving DNS operator-owned", async () => {
    const server = freshServer();
    const app = freshApp();
    const replica = attachReplica(app.id, server.id, app.name);
    const result = await destroyApp(app.id);

    expect(result.ok).toBe(true);
    expect(removeContainer).toHaveBeenCalledTimes(1);
    expect(removeContainer.mock.calls[0][0]).toBe("1.2.3.4");
    expect(removeContainer.mock.calls[0][1]).toBe(app.name);
    expect(syncAllTraefik).toHaveBeenCalledTimes(1);

    // DB rows gone.
    expect(db.getApp(app.id)).toBeNull();
    expect(db.getReplica(replica.id)).toBeNull();
  });

  test("returns ok:false when the app does not exist", async () => {
    const result = await destroyApp(999_999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

});

describe("destroyApp: volume cleanup", () => {
  test("detaches and retains the associated managed volume", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppVolume(app.id, "vol-abc", "/data", false, "hetzner-block");

    await destroyApp(app.id);

    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
    expect(compute._mocks.volumeDetach).toHaveBeenCalledWith("vol-abc");
    expect(db.getRetiredVolumes().some((v) => v.provider_volume_id === "vol-abc")).toBe(true);
  });

  test("detaches (never deletes) an attached-existing volume on destroy", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    // attached=true marks a pre-existing volume attached via attach_existing_volume.
    db.updateAppVolume(app.id, "vol-preexisting", "/data", true, "hetzner-block");

    await destroyApp(app.id);

    // Detached, not deleted — deleting would destroy data we don't own.
    expect(compute._mocks.volumeDetach).toHaveBeenCalledTimes(1);
    expect(compute._mocks.volumeDetach.mock.calls[0][0]).toBe("vol-preexisting");
    expect(compute._mocks.volumeDelete).not.toHaveBeenCalled();
    // App teardown still completes.
    expect(db.getApp(app.id)).toBeNull();
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
  test("marks app cleanup_failed when a container removal fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    removeContainer.mockImplementationOnce(async () => { throw new Error("ssh down"); });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(false);
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });

  test("marks app cleanup_failed when volume detach for retirement fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    db.updateAppVolume(app.id, "vol-err", "/data", false, "hetzner-block");
    compute._mocks.volumeDetach.mockImplementationOnce(async () => { throw new Error("detach failed"); });
    const result = await destroyApp(app.id);
    expect(result.ok).toBe(false);
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });

  test("Ingress removal failure is logged but does NOT mark cleanup_failed", async () => {
    // The lifecycle code tolerates ingress failures without setting cleanupFailed.
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    syncAllTraefik.mockImplementationOnce(async () => { throw new Error("ingress 503"); });
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

    // gcServerIfEmpty records durable intent; the infrastructure controller
    // performs provider deletion in a separate retryable pass.
    db.deletePanel();
    await destroyApp(app.id);

    expect(db.getServer(s1.id)?.gc_requested_at).toBeTruthy();
    expect(db.getServer(s2.id)?.gc_requested_at).toBeTruthy();
    expect(compute._mocks.deleteServer).not.toHaveBeenCalled();
  });

  test("does NOT delete the panel's own server, even when it becomes empty", async () => {
    const panelSrv = freshServer();
    db.deletePanel();
    db.insertPanel({
      server_id: panelSrv.id,
      name: "ocd-panel",
      domain: "panel.example.com",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

  test("keeps an operator-owned host enrolled when its last app is destroyed", async () => {
    const server = freshConnectedServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);

    await destroyApp(app.id);

    expect(db.getServer(server.id)).toBeTruthy();
    expect(db.getServer(server.id)?.gc_requested_at).toBeNull();
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
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

  test("retains the cloud server when a child app cleanup fails", async () => {
    const server = freshServer();
    const app = freshApp();
    attachReplica(app.id, server.id, app.name);
    removeContainer.mockImplementationOnce(async () => { throw new Error("ssh down"); });

    const result = await destroyServer(server.id);

    expect(result.ok).toBe(false);
    expect(compute._mocks.deleteServer).not.toHaveBeenCalled();
    expect(db.getServer(server.id)?.status).toBe("cleanup_failed");
    expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
  });

  test("returns error for unknown server id", async () => {
    const result = await destroyServer(999_999);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test("refuses to forget a connected host with retained server-local data", async () => {
    const server = freshConnectedServer();
    const volumeId = `local:${server.id}:retained-data`;
    db.retireVolume({
      providerVolumeId: volumeId,
      driverId: "local-directory",
      formerResourceType: "app",
      formerResourceId: 1,
      formerResourceName: "retained-app",
      reason: "test",
    });

    const result = await destroyServer(server.id);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/server-local volumes/i);
    expect(db.getServer(server.id)).toBeTruthy();
  });
});
