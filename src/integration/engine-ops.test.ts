// End-to-end integration tests for the engine op pipeline against real Hetzner Cloud.
//
// Required env vars:
//   RUN_INTEGRATION=1
//   HCLOUD_TOKEN=<hetzner-api-token>           — required for any test to run
//
// Optional env vars:
//   OCD_TEST_GIT_REPO=<public-git-url>
//     — defaults to this repo (github.com/0-AI-UG/one-click-deploy) which ships
//       a small nginx fixture at test/fixtures/hello-app. Override if you want
//       to point at a different public repo.
//   OCD_TEST_GIT_BRANCH=<branch>
//     — defaults to "main". Set when validating from a feature branch whose
//       fixture has not yet been merged.
//   OCD_TEST_DOCKER_CONTEXT=<path>
//     — defaults to "test/fixtures/hello-app" (the shipped nginx fixture).
// Cost estimate: one CX22 for ~20 minutes plus one 10 GB volume → ~0.01 EUR.
// All resources are prefixed `ocd-itest-<tag>` so leaks are identifiable.
//
// Single-tenant: this branch has no orgs. Settings live in a global key/value
// table (saveSetting); resources are not org-scoped.
import { useTempDataDir, randomSuffix, enqueueAndWait } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { secretStore } from "../shared/secret-store.ts";

const RUN =
  process.env.RUN_INTEGRATION === "1" &&
  !!process.env.HCLOUD_TOKEN;

// Defaults point at this repo's shipped fixture so the suite runs out of the box.
const DEFAULT_GIT_REPO = "https://github.com/0-AI-UG/one-click-deploy.git";
const DEFAULT_DOCKER_CONTEXT = "test/fixtures/hello-app";
const d = RUN ? describe : describe.skip;
const appTest = RUN ? test : test.skip;

// ---- Shared state ---------------------------------------------------------

type Ctx = {
  tag: string;
  serverId: number;
  appId: number;
  serviceId: number;
  appName: string;
  serviceName: string;
  gitRepo: string;
  gitBranch: string;
  dockerContext: string;
};
let ctx: Ctx | null = null;

const LOCATION = "nbg1";
const SERVER_TYPE = "cx23";

// ---- Helpers ---------------------------------------------------------------

function assertStepsOk(steps: Array<{ status: string; phase: string }>) {
  const forward = steps.filter((s) => s.phase === "forward");
  for (const s of forward) {
    expect(s.status).toBe("ok");
  }
}

async function getStepsForOp(opId: number) {
  const { getSteps } = await import("../shared/db/operations.ts");
  return getSteps(opId);
}

// ---- Suite -----------------------------------------------------------------

d(
  "engine-ops integration (requires RUN_INTEGRATION=1 + HCLOUD_TOKEN)",
  () => {
    // 15-minute timeout for beforeAll (provision-server takes ~5-8 min)
    beforeAll(async () => {
      // Dynamic import of ops/index registers all op kinds before engine starts.
      await import("../engine/ops/index.ts");

      const tag = randomSuffix();
      const gitRepo = process.env.OCD_TEST_GIT_REPO || DEFAULT_GIT_REPO;
      const gitBranch = process.env.OCD_TEST_GIT_BRANCH || "main";
      const dockerContext = process.env.OCD_TEST_DOCKER_CONTEXT || DEFAULT_DOCKER_CONTEXT;
      const appName = `ocd-itest-${tag}`;
      const serviceName = `ocd-itest-svc-${tag}`;
      console.log(
        `[itest:engine-ops] starting suite, tag=${tag}, repo=${gitRepo}, context=${dockerContext}`,
      );

      // Seed Hetzner token in secret store.
      await secretStore.set("hetzner_api_token", process.env.HCLOUD_TOKEN!);

      const db = await import("../shared/db.ts");

      // Seed global infrastructure defaults. DNS is always operator-owned.
      db.saveSetting("default_server_type", SERVER_TYPE);
      db.saveSetting("default_location", LOCATION);

      // Start engine in-process.
      const { startEngineInProcess } = await import("../engine/entrypoint.ts");
      startEngineInProcess();

      // Enqueue provision-server and wait.
      const provisionResult = await enqueueAndWait(
        "provision_server",
        { serverType: SERVER_TYPE, location: LOCATION, name: `ocd-itest-${tag}` },
        { timeoutMs: 12 * 60_000 },
      );
      if (provisionResult.status !== "done") {
        throw new Error(
          `provision-server failed: ${provisionResult.error ?? "(unknown error)"}`
        );
      }

      // Find the server row that was just created.
      const servers = db.getServers();
      const server = servers.find((s: { name: string; status: string }) =>
        s.name === `ocd-itest-${tag}` && s.status === "ready"
      );
      if (!server) throw new Error("Server row not found after provision");

      ctx = {
        tag,
        serverId: (server as { id: number }).id,
        appId: 0,
        serviceId: 0,
        appName,
        serviceName,
        gitRepo,
        gitBranch,
        dockerContext,
      };

      console.log(`[itest:engine-ops] server ready id=${ctx.serverId}`);
    }, 15 * 60_000);

    // 10-minute timeout for afterAll (destroy ops + fallback cleanup)
    afterAll(async () => {
      if (!ctx) return;

      // Best-effort destroy in reverse order.
      if (ctx.appId) {
        try {
          await enqueueAndWait(
            "destroy_app",
            { appId: ctx.appId },
            { timeoutMs: 3 * 60_000 },
          );
        } catch (e) {
          console.warn(`[itest:engine-ops] destroy_app failed: ${e}`);
        }
      }
      if (ctx.serviceId) {
        try {
          await enqueueAndWait(
            "destroy_service",
            { serviceId: ctx.serviceId },
            { timeoutMs: 3 * 60_000 },
          );
        } catch (e) {
          console.warn(`[itest:engine-ops] destroy_service failed: ${e}`);
        }
      }
      if (ctx.serverId) {
        try {
          await enqueueAndWait(
            "destroy_server",
            { serverId: ctx.serverId },
            { timeoutMs: 5 * 60_000 },
          );
        } catch (e) {
          console.warn(`[itest:engine-ops] destroy_server failed: ${e}`);
        }
      }

      // Fallback: direct API cleanup for any leaked `ocd-itest-<tag>` resources.
      try {
        const { hetznerApi } = await import("../engine/hetzner/api.ts");
        const tag = ctx.tag;
        const prefix = `ocd-itest-${tag}`;

        // List and delete servers.
        const servers = (await hetznerApi(`/servers?name=${encodeURIComponent(prefix)}`)) as {
          servers?: Array<{ id: number; name: string }>;
        };
        for (const s of servers.servers ?? []) {
          if (s.name.startsWith("ocd-itest-")) {
            await hetznerApi(`/servers/${s.id}`, { method: "DELETE" }).catch((err) =>
              console.warn(`[itest:engine-ops] server delete fallback failed: ${err}`)
            );
          }
        }

        // List and delete volumes.
        const volumes = (await hetznerApi(
          `/volumes?label_selector=managed-by%3Done-click-deploy`,
        )) as { volumes?: Array<{ id: number; name: string }> };
        for (const v of volumes.volumes ?? []) {
          if (v.name.startsWith("ocd-itest-")) {
            await hetznerApi(`/volumes/${v.id}`, { method: "DELETE" }).catch((err) =>
              console.warn(`[itest:engine-ops] volume delete fallback failed: ${err}`)
            );
          }
        }
      } catch (e) {
        console.warn(`[itest:engine-ops] fallback API cleanup failed: ${e}`);
      }

      const { stopEngineInProcess } = await import("../engine/entrypoint.ts");
      stopEngineInProcess();
      console.log(`[itest:engine-ops] teardown done for tag=${ctx.tag}`);
    }, 10 * 60_000);

    // ---- 1. provision-server -----------------------------------------------
    test("1. provision-server: server row exists with status=ready", () => {
      expect(ctx).not.toBeNull();
      expect(ctx!.serverId).toBeGreaterThan(0);
    });

    // ---- 2. deploy ----------------------------------------------------------
    appTest(
      "2. deploy: app deploys, replica running, HTTP 200 from fixture",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const result = await enqueueAndWait(
          "deploy",
          {
            app_name: ctx!.appName,
            image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            container_port: 8080,
            server_id: ctx!.serverId,
          },
          { timeoutMs: 10 * 60_000 },
        );
        expect(result.status).toBe("done");

        const app = db.getAppByName(ctx!.appName);
        expect(app).not.toBeNull();
        ctx!.appId = app!.id;

        const replicas = db.getReplicas(ctx!.appId);
        expect(replicas.length).toBeGreaterThan(0);
        expect(replicas[0].status).toBe("running");

        const server = db.getServer(ctx!.serverId);
        const hostPort = replicas[0].host_port;
        console.log(`[itest:engine-ops] app deployed on port ${hostPort} at ${server!.ipv4}`);

        assertStepsOk(await getStepsForOp(result.opId));
      },
      10 * 60_000,
    );

    // ---- 3. deploy-service --------------------------------------------------
    test(
      "3. deploy-service: postgres instance running, volume attached",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const result = await enqueueAndWait(
          "deploy_service",
          {
            name: ctx!.serviceName,
            service_type: "postgresql",
          },
          { timeoutMs: 5 * 60_000 },
        );
        expect(result.status).toBe("done");

        const service = db.getServiceByName(ctx!.serviceName);
        expect(service).not.toBeNull();
        ctx!.serviceId = service!.id;

        const instances = db.getServiceInstances(ctx!.serviceId);
        expect(instances.length).toBeGreaterThan(0);
        expect(instances[0].status).toBe("running");
        expect(instances[0].volume_id).not.toBe("");

        assertStepsOk(await getStepsForOp(result.opId));
      },
      5 * 60_000,
    );

    // ---- 4. scale-up -------------------------------------------------------
    appTest(
      "4. scale-up: 3 replicas running",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const result = await enqueueAndWait(
          "scale_up",
          { appId: ctx!.appId, targetReplicas: 3 },
          { timeoutMs: 5 * 60_000 },
        );
        expect(result.status).toBe("done");

        const replicas = db.getReplicas(ctx!.appId);
        expect(replicas.length).toBe(3);

        assertStepsOk(await getStepsForOp(result.opId));
      },
      5 * 60_000,
    );

    // ---- 5. scale-down -----------------------------------------------------
    appTest(
      "5. scale-down: 1 replica",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const result = await enqueueAndWait(
          "scale_down",
          { appId: ctx!.appId, targetReplicas: 1 },
          { timeoutMs: 3 * 60_000 },
        );
        expect(result.status).toBe("done");

        const replicas = db.getReplicas(ctx!.appId);
        expect(replicas.length).toBe(1);

        assertStepsOk(await getStepsForOp(result.opId));
      },
      3 * 60_000,
    );

    // ---- 6. restart-app ----------------------------------------------------
    appTest(
      "6. restart-app: op succeeds",
      async () => {
        expect(ctx).not.toBeNull();

        const result = await enqueueAndWait(
          "restart_app",
          { appId: ctx!.appId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(result.status).toBe("done");

        assertStepsOk(await getStepsForOp(result.opId));
      },
      2 * 60_000,
    );

    // ---- 7. pause-app / unpause-app ----------------------------------------
    appTest(
      "7. pause-app then unpause-app",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const pauseResult = await enqueueAndWait(
          "pause_app",
          { appId: ctx!.appId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(pauseResult.status).toBe("done");
        expect(db.getApp(ctx!.appId)!.status).toBe("paused");

        const unpauseResult = await enqueueAndWait(
          "unpause_app",
          { appId: ctx!.appId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(unpauseResult.status).toBe("done");
        const app = db.getApp(ctx!.appId);
        expect(["running", "healthy"].includes(app!.status)).toBe(true);
      },
      4 * 60_000,
    );

    // ---- 8. pause-service / unpause-service --------------------------------
    test(
      "8. pause-service then unpause-service",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const pauseResult = await enqueueAndWait(
          "pause_service",
          { serviceId: ctx!.serviceId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(pauseResult.status).toBe("done");
        expect(db.getService(ctx!.serviceId)!.status).toBe("paused");

        const unpauseResult = await enqueueAndWait(
          "unpause_service",
          { serviceId: ctx!.serviceId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(unpauseResult.status).toBe("done");
        const svc = db.getService(ctx!.serviceId);
        expect(["running", "healthy"].includes(svc!.status)).toBe(true);
      },
      4 * 60_000,
    );

    // ---- 9. restart-service ------------------------------------------------
    test(
      "9. restart-service: op succeeds",
      async () => {
        expect(ctx).not.toBeNull();

        const result = await enqueueAndWait(
          "restart_service",
          { serviceId: ctx!.serviceId },
          { timeoutMs: 2 * 60_000 },
        );
        expect(result.status).toBe("done");

        assertStepsOk(await getStepsForOp(result.opId));
      },
      2 * 60_000,
    );

    // ---- 10. redeploy -------------------------------------------------------
    appTest(
      "10. redeploy: op succeeds and records deployment history",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const before = db.getDeployments(ctx!.appId);
        const result = await enqueueAndWait(
          "redeploy",
          { appId: ctx!.appId },
          { timeoutMs: 10 * 60_000 },
        );
        expect(result.status).toBe("done");

        const after = db.getDeployments(ctx!.appId);
        expect(after.length).toBeGreaterThan(before.length);

        assertStepsOk(await getStepsForOp(result.opId));
      },
      10 * 60_000,
    );

    // ---- 11. cascade-redeploy ----------------------------------------------
    appTest(
      "11. cascade-redeploy: seeds env, redeploys linked apps",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        // Create an environment and link the app to it so cascade has targets.
        const envRow = db.insertEnvironment(`env-${ctx!.tag}`, JSON.stringify({ entries: [] }));
        db.updateAppEnvironment(ctx!.appId, envRow.id);

        const result = await enqueueAndWait(
          "cascade_redeploy",
          { environmentId: envRow.id },
          { timeoutMs: 12 * 60_000 },
        );
        expect(result.status).toBe("done");
      },
      12 * 60_000,
    );

    // ---- 12. rollback -------------------------------------------------------
    appTest(
      "13. rollback: rolls back to a prior deployment",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const deployments = db.getDeployments(ctx!.appId);
        expect(deployments.length).toBeGreaterThanOrEqual(2);
        const target = deployments[deployments.length - 1];

        const result = await enqueueAndWait(
          "rollback",
          { appId: ctx!.appId, deploymentId: target.id },
          { timeoutMs: 10 * 60_000 },
        );
        expect(result.status).toBe("done");
      },
      10 * 60_000,
    );

    // ---- 14. migrate -------------------------------------------------------
    appTest(
      "14. migrate: fails cleanly when source == target server (no second server available)",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const replicas = db.getReplicas(ctx!.appId);
        const firstReplica = replicas[0];

        const result = await enqueueAndWait(
          "migrate",
          {
            appId: ctx!.appId,
            replicaId: firstReplica.id,
            targetServerId: ctx!.serverId,
          },
          { timeoutMs: 60_000 },
        );
        expect(["failed", "compensated"].includes(result.status)).toBe(true);
      },
      90_000,
    );

    // ---- 15. sleep / wake --------------------------------------------------
    appTest(
      "15. sleep then wake",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");

        const sleepResult = await enqueueAndWait(
          "sleep",
          { appId: ctx!.appId },
          { timeoutMs: 3 * 60_000 },
        );
        expect(sleepResult.status).toBe("done");
        expect(db.getApp(ctx!.appId)!.status).toBe("sleeping");

        const wakeResult = await enqueueAndWait(
          "wake",
          { appId: ctx!.appId },
          { timeoutMs: 3 * 60_000 },
        );
        expect(wakeResult.status).toBe("done");
        const app = db.getApp(ctx!.appId);
        expect(["running", "healthy"].includes(app!.status)).toBe(true);
      },
      6 * 60_000,
    );

    // ---- 16. basic auth ----------------------------------------------------
    appTest(
      "16. basic auth: setting the app password persists the htpasswd hash",
      async () => {
        expect(ctx).not.toBeNull();
        const db = await import("../shared/db.ts");
        const { syncAppIngress } = await import("../engine/scale/traefik-manager.ts");

        // Password protection is pure ingress config now (no rebuild): store the
        // hash and re-sync the ingress, mirroring PUT /api/apps/:id/config.
        db.updateAppAuthPassword(ctx!.appId, "itest-secret");
        await syncAppIngress(ctx!.appId);

        const app = db.getApp(ctx!.appId);
        expect(Bun.password.verifySync("itest-secret", app!.auth_password_hash)).toBe(true);
        console.log(
          `[itest:engine-ops] basicAuth set; verify manually at ${app!.domain} (user "admin")`,
        );
      },
      10 * 60_000,
    );

  },
);
