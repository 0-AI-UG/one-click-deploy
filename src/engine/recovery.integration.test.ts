// End-to-end engine integration tests with a simulated Hetzner provider.
// These exercise the FULL op pipeline via runOperation: probe-based idempotency
// adoption, compensation rollback, mid-compensation crash recovery, and the
// precondition-guard short-circuit. No real cloud or SSH is contacted.
//
// Gated behind RUN_ENGINE_INTEGRATION=1 because the `mock.module()` calls below
// are process-global in bun:test — running this file alongside the rest of the
// suite would replace `host-mounts.ts` etc. for every test in the process.
// Run with:  RUN_ENGINE_INTEGRATION=1 bun test src/engine/recovery.integration.test.ts

import { useTempDataDir, makeFakeComputeProvider, makeFakeDnsProvider, randomSuffix } from "../shared/test-helpers.ts";

import { describe, test, expect, mock, beforeEach } from "bun:test";

const RUN = process.env.RUN_ENGINE_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;

if (RUN) useTempDataDir();

// ---- Provider + remote stubs (must register before importing ops) ----------

const compute = makeFakeComputeProvider();
const dns = makeFakeDnsProvider();
if (RUN) mock.module("../shared/providers/index.ts", () => ({
  getComputeProvider: () => compute,
  getDnsProvider: () => dns,
}));

// provisionServer is only called when no ready server exists; stub it.
const provisionServer = mock(async (opts: { name: string }) => ({
  id: 12345,
  provider_id: `h-${opts.name}`,
  ipv4: "5.5.5.5",
  ssh_host_key: "",
}));
if (RUN) mock.module("./provision-server.ts", () => ({ provisionServer }));

// Track the simulated docker world: containers and dirs that "exist" on the host.
type FakeWorld = {
  containers: Set<string>;
  composeDirs: Set<string>;
  shouldBuildFail: boolean;
};
const world: FakeWorld = {
  containers: new Set(),
  composeDirs: new Set(),
  shouldBuildFail: false,
};

const remoteMocks = {
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  cloneRepo: mock(async () => {}),
  cloneAndBuild: mock(async (_ip: string, opts: { name: string }) => {
    if (world.shouldBuildFail) throw new Error("simulated build failure");
    world.containers.add(opts.name);
    return { imageTag: `${opts.name}:latest` };
  }),
  cloneAndComposeBuild: mock(async () => ({ composeFile: "docker-compose.yml", webService: "web" })),
  detectComposeFile: mock(async () => ""),
  detectWebService: mock(async () => "web"),
  removeContainer: mock(async (_ip: string, name: string) => { world.containers.delete(name); }),
  removeCompose: mock(async (_ip: string, name: string) => { world.composeDirs.delete(name); world.containers.delete(name); }),
  healthCheck: mock(async () => ({ healthy: true, statusCode: 200 })),
  composeHealthCheck: mock(async () => ({ healthy: true, statusCode: 200 })),
  deployAuthProxy: mock(async (_ip: string, name: string) => { world.containers.add(`${name}-auth`); return 9999; }),
  removeAuthProxy: mock(async (_ip: string, name: string) => { world.containers.delete(`${name}-auth`); }),
  containerExists: mock(async (_ip: string, name: string) => world.containers.has(name)),
  composeProjectExists: mock(async (_ip: string, name: string) => world.composeDirs.has(name)),
  pauseContainer: mock(async () => {}),
  unpauseContainer: mock(async () => {}),
  restartContainer: mock(async () => {}),
  serviceHealthCheck: mock(async () => ({ healthy: true })),
  // Unused-but-imported by destroy ops:
  authProxyPort: (p: number) => p + 1,
};
if (RUN) {
  mock.module("../shared/remote/index.ts", () => remoteMocks);
  mock.module("./scale/caddy-manager.ts", () => ({
    syncAppCaddy: mock(async () => {}),
    removeAppCaddy: mock(async () => {}),
  }));
  mock.module("./scale-api.ts", () => ({ scaleApp: mock(async () => ({ ok: true })) }));
  mock.module("../shared/github.ts", () => ({
    getGitHubPat: async () => null,
    deleteWebhook: async () => {},
    createWebhookAtUrl: async () => ({ id: 1 }),
  }));
  // engine.ts has module-level state (parkOp/unparkOp); stub for direct runOperation use.
  mock.module("./engine.ts", () => ({ parkOp: () => {}, unparkOp: () => {} }));
  // setup_volume_bind_mount imports hetzner/host-mounts at runtime; stub it.
  mock.module("./hetzner/host-mounts.ts", () => ({
    ensureVolumeBindMount: mock(async () => {}),
    removeVolumeBindMount: mock(async () => {}),
  }));
}

// pauseApp/restartApp/unpauseApp call into remote/index.ts (already stubbed
// above), so we leave lifecycle.ts unmocked. Mocking it globally would break
// other test files that exercise the real lifecycle functions.

import * as db from "../shared/db.ts";
import {
  enqueueOperation,
  getOperation,
  getSteps,
} from "../shared/db/operations.ts";
import { runOperation } from "./step-runner.ts";
import deployOp from "./ops/deploy.ts";
import pauseAppOp from "./ops/pause-app.ts";
// Ensure all ops are registered (some import deploy/lifecycle which is now mocked).
import "./ops/index.ts";

// ---- Helpers ---------------------------------------------------------------

function seedReadyServer(): { id: number; ipv4: string } {
  // Insert a fresh server per test. We can't delete prior servers because
  // earlier tests leave behind apps/replicas with FK references.
  const s = db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: `9.9.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    private_ipv4: "10.0.0.2",
  });
  // Mark older servers as provisioning so deploy.ts picks our fresh one.
  for (const other of db.getServers()) {
    if (other.id !== s.id && other.status === "ready") {
      db.updateServerStatus(other.id, "provisioning");
    }
  }
  return { id: s.id, ipv4: s.ipv4 };
}

async function runOp(kind: string, input: unknown) {
  const row = enqueueOperation({ kind, resourceKeys: [], input, trigger: "test" });
  const op = getOperation(row.id)!;
  // Find the registered definition (deploy uses the imported handle; for
  // others we ask the registry).
  const { getOp } = await import("./ops/registry.ts");
  const def = getOp(kind)!;
  await runOperation(op, def);
  return getOperation(row.id)!;
}

const baseDeployReq = (name: string) => ({
  app_name: name,
  git_repo: "https://github.com/x/y",
  container_port: 3000,
  domain: "",
});

beforeEach(() => {
  // Reset world + provider mocks per test.
  world.containers.clear();
  world.composeDirs.clear();
  world.shouldBuildFail = false;
  for (const m of Object.values(remoteMocks)) {
    if (typeof m === "function" && "mockClear" in (m as any)) (m as any).mockClear();
  }
  for (const m of Object.values(compute._mocks)) m.mockClear();
  for (const m of Object.values(dns._mocks)) m.mockClear();
  provisionServer.mockClear();
});

// ---- 1. Full deploy lifecycle ----------------------------------------------

d("deploy: full lifecycle through runOperation", () => {
  test("happy path completes 'done' and creates app/replica/volume rows", async () => {
    seedReadyServer();
    const name = `app-${randomSuffix()}`;
    const fin = await runOp("deploy", { ...baseDeployReq(name), volume_size: 10 });

    expect(fin.status).toBe("done");
    const app = db.getAppByName(name);
    expect(app).not.toBeNull();
    expect(app!.volume_id).toBeTruthy();

    // Volume was created exactly once.
    expect(compute._mocks.volumeCreate).toHaveBeenCalledTimes(1);
    // Container was started.
    expect(world.containers.has(name)).toBe(true);
  });
});

// ---- 2. Probe adoption: simulated mid-step crash on volume create ----------

d("deploy: probe adopts orphaned side effect on resume", () => {
  test("create_volume.probe finds an existing volume and skips create", async () => {
    seedReadyServer();
    const name = `probed-${randomSuffix()}`;
    const expectedVolName = `ocd-${name}-data`;

    // Simulate: a prior crashed attempt already created the volume. The fake
    // provider's volumes.list() returns it; the probe should adopt.
    compute.volumes!.list = mock(async () => [{
      providerId: "v-already-here",
      name: expectedVolName,
      sizeGb: 10,
      location: "fsn1",
      serverId: null,
    }]);

    const fin = await runOp("deploy", { ...baseDeployReq(name), volume_size: 10 });

    expect(fin.status).toBe("done");
    // CRITICAL: volume create was NOT called — the probe adopted the existing one.
    expect(compute._mocks.volumeCreate).not.toHaveBeenCalled();
    const app = db.getAppByName(name);
    expect(app!.volume_id).toBe("v-already-here");
  });

  test("insert_app_row.probe returns the existing row instead of inserting a duplicate", async () => {
    // Call the probe directly — pickOrProvisionServer's preflight rejects
    // duplicate names, so we can't run the full op end-to-end for this case.
    // But the probe itself is the safety net: if the runner re-enters the
    // step after a crash, the probe adopts the prior insert.
    const server = seedReadyServer();
    const name = `preexisting-${randomSuffix()}`;
    const seeded = db.insertAppWithFirstReplica(
      {
        name,
        domain: `${name}.${server.ipv4}.nip.io`,
        git_repo: "https://github.com/x/y",
        dockerfile_path: "Dockerfile",
        docker_context: "",
        container_port: 3000,
        env_vars: "{}",
        auth_password: "",
        public: 1,
      },
      server.id,
    );

    const step = deployOp.steps.find((s) => s.name === "insert_app_row")!;
    expect(step.probe).toBeDefined();
    const ctx = {
      opId: 99,
      kind: "deploy",
      input: baseDeployReq(name),
      trigger: "test",
      triggeredBy: "",
      parentId: null,
      attempt: 1,
      isCancelRequested: () => false,
      log: () => {},
      park: () => {},
      unpark: () => {},
    } as any;
    const prior = {
      pick_or_provision_server: { serverId: server.id, serverIp: server.ipv4, serverHostKey: "", provisioned: false, ingressIp: server.ipv4 },
    };
    const adopted = await step.probe!(ctx, prior);

    expect(adopted).not.toBeNull();
    expect((adopted as any).appId).toBe(seeded.app.id);
    expect((adopted as any).replicaId).toBe(seeded.replica.id);
  });
});

// ---- 3. Compensation rolls back in reverse on a failure --------------------

d("deploy: compensation rolls back side effects on forward failure", () => {
  test("a forward failure triggers reverse compensation: container, app row, volume, DNS", async () => {
    seedReadyServer();
    db.saveSetting("dns_zone_id", "zone-1");

    const name = `rollback-${randomSuffix()}`;
    world.shouldBuildFail = true; // build step throws → triggers rollback

    const fin = await runOp("deploy", {
      ...baseDeployReq(name),
      domain: "rollback.example.com",
      volume_size: 5,
    });

    expect(["compensated", "compensating"]).toContain(fin.status);
    // DNS compensate called (forward step succeeded → compensate undoes it).
    expect(dns._mocks.deleteRecord).toHaveBeenCalled();
    // Volume compensate called.
    expect(compute._mocks.volumeDelete).toHaveBeenCalled();
    // App row was undone (deleted by insert_app_row.compensate).
    expect(db.getAppByName(name)).toBeNull();

    // Compensate steps appear in REVERSE order in the steps table.
    const steps = getSteps(fin.id).filter((s) => s.phase === "compensate" && s.status === "ok");
    const order = steps.map((s) => s.step);
    // create_dns_record must appear AFTER create_volume in compensate phase
    // (since it ran BEFORE create_volume in forward phase, reverse order).
    const volIdx = order.indexOf("create_volume");
    const dnsIdx = order.indexOf("create_dns_record");
    if (volIdx >= 0 && dnsIdx >= 0) expect(dnsIdx).toBeGreaterThan(volIdx);
  });
});

// ---- 4. Resumable compensation: simulate crash mid-rollback ----------------

d("deploy: compensation is resumable across simulated crashes", () => {
  test("compensate steps marked 'ok' from a prior crash are not re-run on resume", async () => {
    seedReadyServer();
    db.saveSetting("dns_zone_id", "zone-1");
    const name = `resumecomp-${randomSuffix()}`;
    world.shouldBuildFail = true;

    // First pass: forward fails at build → compensation rolls everything back.
    const first = await runOp("deploy", {
      ...baseDeployReq(name),
      domain: "resume.example.com",
      volume_size: 3,
    });
    expect(first.status).toBe("compensated");

    const dnsDeletesAfterFirst = dns._mocks.deleteRecord.mock.calls.length;
    const volDeletesAfterFirst = compute._mocks.volumeDelete.mock.calls.length;
    expect(dnsDeletesAfterFirst).toBeGreaterThan(0);
    expect(volDeletesAfterFirst).toBeGreaterThan(0);

    // Simulate a crash that left the op in 'compensating' with the existing
    // compensate rows still 'ok'. Reset status; the runner must see them as
    // already-done and not re-invoke the compensate bodies.
    const { default: conn } = await import("../shared/db/connection.ts");
    conn.run(
      "UPDATE operations SET status = 'compensating', finished_at = NULL WHERE id = ?",
      [first.id],
    );

    const reloaded = getOperation(first.id)!;
    const { getOp } = await import("./ops/registry.ts");
    await runOperation(reloaded, getOp("deploy")!);

    const fin = getOperation(first.id)!;
    expect(fin.status).toBe("compensated");
    // No additional provider calls — every compensate row was already 'ok'.
    expect(dns._mocks.deleteRecord.mock.calls.length).toBe(dnsDeletesAfterFirst);
    expect(compute._mocks.volumeDelete.mock.calls.length).toBe(volDeletesAfterFirst);
  });
});

// ---- 5. Precondition guard short-circuits trivial ops ----------------------

d("pause_app: precondition guard avoids duplicate work", () => {
  test("running pause_app twice doesn't call pauseApp twice", async () => {
    const server = seedReadyServer();
    const name = `pa-${randomSuffix()}`;
    const seeded = db.insertAppWithFirstReplica(
      {
        name,
        domain: `${name}.${server.ipv4}.nip.io`,
        git_repo: "https://github.com/x/y",
        dockerfile_path: "Dockerfile",
        docker_context: "",
        container_port: 3000,
        env_vars: "{}",
        auth_password: "",
        public: 1,
      },
      server.id,
    );
    // Manually mark as 'paused' to simulate the state after a successful pause.
    db.updateAppStatus(seeded.app.id, "paused");

    const pauseCalls = remoteMocks.pauseContainer.mock.calls.length;
    const fin = await runOp("pause_app", { appId: seeded.app.id });

    expect(fin.status).toBe("done");
    // The pauseReplicas step short-circuited via the precondition guard, so
    // no new container pauses happened.
    expect(remoteMocks.pauseContainer.mock.calls.length).toBe(pauseCalls);

    // Confirm via steps table: pause_replicas finished ok but its work was a
    // no-op (output marked skipped).
    const steps = getSteps(fin.id);
    const pauseStep = steps.find((s) => s.step === "pause_replicas");
    expect(pauseStep?.status).toBe("ok");
    const out = pauseStep?.output_json ? JSON.parse(pauseStep.output_json) : null;
    expect(out?.skipped).toBe(true);
  });
});
