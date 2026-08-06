// Contract tests: topology-changing operations (sleep via scaleDown, wake via
// wakeApp) must push the fleet proxy config immediately instead of waiting for
// the 30s reconciler tick. Docker/SSH and the Traefik ingress sync are mocked;
// the DB is the real temp-dir instance.
import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// mock.module factories must cover the COMPLETE export surface of the mocked
// module (Bun module namespaces are sealed — a later re-mock in another test
// file cannot add slots this factory omits). Spread the real namespace and
// override only what these tests stub.
import * as realRemote from "../../shared/remote/index.ts";
import * as realTraefikManager from "./traefik-manager.ts";

let attestationTarget: { name: string; configRevision: number; envHash: string } | null = null;

const sshExec = mock(async (_host: string, cmd: string, _hostKey?: string) => {
  let stdout = "";
  if (cmd.includes("docker image inspect")) stdout = "yes\n";
  if (cmd.includes("docker inspect")) {
    stdout = JSON.stringify({
      Image: "sha256:test-image",
      State: { Running: true },
      Config: {
        Labels: {
          "ocd.app": attestationTarget?.name || "",
          "ocd.image-id": "sha256:test-image",
          "ocd.image-ref": attestationTarget ? `${attestationTarget.name}:latest` : "",
          "ocd.env-hash": attestationTarget?.envHash || "",
          "ocd.config-revision": String(attestationTarget?.configRevision || 0),
        },
      },
    });
  }
  return { exitCode: 0, stdout, stderr: "" };
});
mock.module("../../shared/remote/index.ts", () => ({
  ...realRemote,
  sshExec,
  getSshKeyPath: () => "/tmp/test-key",
  healthCheck: mock(async () => ({ healthy: true })),
  probeAppHealth: mock(async () => ({ healthy: true })),
  startAppReplica: mock(async () => {}),
  startContainer: mock(async () => true),
  containerExists: mock(async () => true),
  stopContainer: mock(async () => {}),
}));
mock.module("./traefik-manager.ts", () => ({
  ...realTraefikManager,
  syncAppIngress: mock(async () => {}),
  syncAllTraefik: mock(async () => {}),
}));

import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import { hashEnvironment } from "../revision.ts";
import { wakeApp } from "./wake.ts";
import { scaleDown } from "./scale-down.ts";

function makeServer() {
  return db.insertServer({
    name: `srv-tp-${randomSuffix()}`,
    provider_id: `h-tp-${randomSuffix()}`,
    ipv4: `198.51.100.${100 + Math.floor(Math.random() * 50)}`,
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    private_ipv4: "10.0.80.2",
  });
}

function makeApp() {
  const app = db.insertApp({
    name: `tp-app-${randomSuffix()}`,
    domain: "",
    git_repo: "https://x.git",
    dockerfile_path: "Dockerfile",
    container_port: 3000,
    env_vars: "{}",
  });
  attestationTarget = { name: app.name, configRevision: app.config_revision, envHash: "" };
  return app;
}

beforeEach(() => {
  sshExec.mockClear();
});

describe("contract: P3a topology-changing ops push proxy config immediately", () => {
  // REGRESSION: currently failing by design — sleep/wake only re-render the
  // Traefik ingress (syncAppIngress); the fleet ocd-proxy config is left to
  // the 30s reconciler tick, so for up to a tick the proxy routes a woken app
  // to nothing / keeps a slept app's dead backends. Contract seam (invented
  // here — the fix must match these names in src/engine/scale/proxy-manager.ts):
  //   export async function pushProxyForApp(appId: number): Promise<void>
  //     — immediately converge the ocd-proxy config (and hosts sync) for the
  //       servers affected by the app's topology change; called by
  //       scale-down's sleep path and by wakeApp after the app is running.
  //   export function __setProxyPush(
  //     fn: ((appId: number) => Promise<void>) | null,
  //   ): void
  //     — test seam: override (or with null restore) the implementation
  //       pushProxyForApp delegates to, mirroring __setWakerDeps in waker.ts.

  test("wakeApp invokes pushProxyForApp for the woken app", async () => {
    const pm: any = await import("./proxy-manager.ts");
    expect(typeof pm.pushProxyForApp).toBe("function");
    expect(typeof pm.__setProxyPush).toBe("function");

    const pushed: number[] = [];
    pm.__setProxyPush(async (appId: number) => {
      pushed.push(appId);
    });
    try {
      const server = makeServer();
      const app = makeApp();
      attestationTarget!.envHash = hashEnvironment(await resolveAppEnvVars(app));
      db.updateAppSleepingState(app.id, server.id, 10801);
      db.updateAppStatus(app.id, "sleeping");

      const result = await wakeApp(app.id);
      expect(result.ok).toBe(true);
      expect(db.getApp(app.id)!.status).toBe("running");
      expect(pushed).toContain(app.id);
    } finally {
      pm.__setProxyPush(null);
    }
  });

  test(
    "scaleDown's sleep path invokes pushProxyForApp",
    async () => {
      const pm: any = await import("./proxy-manager.ts");
      expect(typeof pm.pushProxyForApp).toBe("function");
      expect(typeof pm.__setProxyPush).toBe("function");

      const pushed: number[] = [];
      pm.__setProxyPush(async (appId: number) => {
        pushed.push(appId);
      });
      try {
        const server = makeServer();
        const app = makeApp();
        const replica = db.insertReplica({
          app_id: app.id,
          server_id: server.id,
          host_port: 10802,
          container_name: app.name,
          status: "running",
        });

        // 1 → 0: the sleep path (includes the real 10s drain wait).
        await scaleDown(db.getApp(app.id)!, [replica], 1, 0, () => {});

        expect(db.getApp(app.id)!.status).toBe("sleeping");
        expect(pushed).toContain(app.id);
      } finally {
        pm.__setProxyPush(null);
      }
    },
    30_000,
  );
});
