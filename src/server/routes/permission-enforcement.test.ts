/**
 * End-to-end permission ENFORCEMENT regression suite.
 *
 * Every other route suite in this directory calls `mock.module("../lib/permissions.ts", ...)`
 * to bypass auth entirely, so none of them prove that any route actually refuses
 * anyone. This file is the counterweight: real signed JWTs, real `Request`
 * objects, the real exported route handlers, and the REAL permission layer.
 *
 * ---------------------------------------------------------------------------
 * The mock.module trap
 * ---------------------------------------------------------------------------
 * `mock.module` is process-wide in Bun and it MERGES into the live module
 * namespace, so a stub registered by an earlier file (apps-auth.test.ts sorts
 * before this one) is still installed when this file loads. Plain
 * `await import("../lib/permissions.ts")` would therefore hand us the STUB and
 * every assertion below would pass vacuously.
 *
 * Three defences, all of them load-bearing (each was observed failing without
 * the others while this file was written):
 *   1. We load a pristine copy through a cache-busting `?real` specifier — Bun
 *      keys mocks by resolved path, so the query yields the original module —
 *      and assert at load time that it really is the unstubbed one. The
 *      specifier must stay a bare relative string; normalising it through
 *      `new URL(..., import.meta.url)` drops the query and hands back the mock.
 *   2. `beforeEach` re-registers that copy, which makes this file the most
 *      recent registration for the duration of its own tests. The factory must
 *      return a PLAIN object (`{ ...realPermissions }`); handing `mock.module`
 *      a module-namespace exotic object is silently ignored when the path is
 *      already mocked, leaving the other suite's bypass in place.
 *   3. The "bypass guard" describe block below fails loudly if a stub is
 *      somehow still live (identity check on the exported function, plus a
 *      no-permission user hitting a known-protected handler).
 */
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

// --- pristine permission layer ----------------------------------------------
// Built from a non-literal specifier so tsc does not try to resolve the query.
const REAL_PERMISSIONS_SPECIFIER: string = "../lib/permissions.ts?real";
const realPermissions = (await import(
  REAL_PERMISSIONS_SPECIFIER
)) as typeof import("../lib/permissions.ts");
if (!realPermissions.requirePermission.toString().includes("hasPermission")) {
  throw new Error(
    "permission-enforcement.test.ts: failed to load a pristine ../lib/permissions.ts — " +
      "another suite's bypass stub is what we would be testing against.",
  );
}

// --- side-effect stubs ------------------------------------------------------
// Only genuine I/O boundaries are stubbed; the permission layer never is.
import * as remote from "../../shared/remote/index.ts";
import * as enginePanel from "../../engine/deploy/panel.ts";
import * as traefik from "../../engine/scale/traefik-manager.ts";

// Captured before we install our own stubs so we can hand the process back
// whatever was installed when this file loaded (engine suites run first and
// stub several of these themselves).
const priorSshExec = remote.sshExec;
const priorRedeployPanel = enginePanel.redeployPanel;
const priorSyncAppIngress = traefik.syncAppIngress;

beforeEach(() => {
  // Re-register the REAL permission layer so this file wins over any bypass
  // stub left behind by another suite. Files execute sequentially, so this is
  // the most recent registration while our tests run.
  // NOTE: spread into a plain object. Handing `mock.module` a module namespace
  // exotic object directly is silently ignored when the path is already mocked,
  // which would leave another suite's bypass stub in place.
  mock.module("../lib/permissions.ts", () => ({ ...realPermissions }));
  mock.module("../../shared/remote/index.ts", () => ({
    sshExec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  }));
  mock.module("../../engine/deploy/panel.ts", () => ({
    redeployPanel: async () => ({ ok: true }),
  }));
  mock.module("../../engine/scale/traefik-manager.ts", () => ({
    syncAppIngress: async () => {},
  }));
});

afterAll(() => {
  mock.module("../../shared/remote/index.ts", () => ({ sshExec: priorSshExec }));
  mock.module("../../engine/deploy/panel.ts", () => ({ redeployPanel: priorRedeployPanel }));
  mock.module("../../engine/scale/traefik-manager.ts", () => ({ syncAppIngress: priorSyncAppIngress }));
});

import * as db from "../../shared/db.ts";
import { ALL_PERMISSIONS, type PermissionGrant } from "../../shared/db/users.ts";
import { enqueueOperation } from "../../shared/db/operations.ts";
import { createToken } from "../lib/auth.ts";
import { createConfirmation, resolveConfirmation } from "../lib/action-confirm.ts";

import {
  handleGetApps,
  handleDeploy,
  handleDestroyApp,
  handleRestartApp,
  handlePauseApp,
  handleRollbackApp,
  handleGetContainerLogs,
  handleGetDeployments,
  handleGetDeployLog,
  handleGetDashboard,
} from "./apps.ts";
import {
  handleGetStacks,
  handleGetStack,
  handleDeployStack,
  handleDestroyStack,
  handlePromoteStack,
  handleGetStackLog,
} from "./stacks.ts";
import {
  handleGetServices,
  handleGetCatalog,
  handleDeployService,
  handleDestroyService,
  handleRestartService,
  handleInjectService,
} from "./services.ts";
import {
  handleGetEnvironments,
  handleGetDeletedEnvironments,
  handleCreateEnvironment,
  handleUpdateEnvironment,
  handleDeleteEnvironment,
  handleRestoreEnvironment,
  handlePurgeEnvironment,
  handleGetEnvironmentApps,
} from "./environments.ts";
import {
  handleWakeApp,
  handleMigrateReplica,
  handleGetReplicas,
} from "./scaling.ts";
import { handleDeleteServer, handleSetServerPool, handleGetServers } from "./servers.ts";
import {
  handleGetResources,
  handleDeleteResource,
  handleListVolumeFiles,
  handleCreateServer,
  handleGetVolumeDeletionAudit,
} from "./resources.ts";
import { handleListOperations, handleCancelOperation } from "./operations.ts";
import { handleGetPanel, handleRedeployPanel } from "./panel.ts";
import {
  handleEnablePanelWebhook,
  handleDisablePanelWebhook,
} from "./webhooks.ts";
import { handleTerminalExec } from "./terminal-exec.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
const uid = () => `pe-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 7)}`;

type Ctx = { token: string; userId: string };

async function userWith(
  grants: ReadonlyArray<string | PermissionGrant>,
  opts: { admin?: boolean; cli?: boolean } = {},
): Promise<Ctx> {
  const id = uid();
  db.insertUser({ id, username: id, password_hash: "x", is_admin: opts.admin });
  db.setUserPermissions(id, grants as Array<string | PermissionGrant>);
  const token = await createToken({
    userId: id,
    username: id,
    ...(opts.cli ? { client: "cli" as const } : {}),
  });
  return { token, userId: id };
}

function req(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...opts.headers,
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return new Request(`http://panel.test${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const grant = (
  permission: string,
  scopeType: "global" | "app" | "environment",
  scopeId?: number,
): PermissionGrant => ({
  permission,
  scopeType,
  scopeId: scopeId == null ? null : String(scopeId),
});

// Fleet fixtures. Deliberately NOT created once: the whole run shares one temp
// DB and several other suites wipe `apps`/`servers`/`replicas` wholesale from
// their own hooks, so anything seeded at module load is gone by the time an
// interleaved file has run. `beforeEach` re-seeds whenever the fixtures have
// been swept out from under us, which makes this file independent of the order
// Bun happens to load test files in.
let envA = 0;
let envB = 0;
let appA = 0; // in envA, has one replica
let appB = 0; // in envB, no replicas
let serverS = 0;
let replicaR = 0;
let stackA = 0; // every member in envA
let stackX = 0; // members split across envA/envB -> no scoped grant can satisfy
let serviceX = 0;

function seedFleet(): void {
  envA = db.insertEnvironment(`perm-envA-${uid()}`, "{}").id;
  envB = db.insertEnvironment(`perm-envB-${uid()}`, "{}").id;

  serverS = db.insertServer({
    name: `perm-srv-${uid()}`,
    provider_id: `hz-${uid()}`,
    ipv4: "203.0.113.7",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "running",
  }).id;

  const mkApp = (environmentId: number) =>
    db.insertApp({
      name: `perm-app-${uid()}`,
      domain: `${uid()}.example.com`,
      git_repo: "https://github.com/x/y",
      dockerfile_path: "Dockerfile",
      container_port: 3000,
      env_vars: "{}",
      environment_id: environmentId,
    }).id;

  appA = mkApp(envA);
  appB = mkApp(envB);

  replicaR = db.insertReplica({
    app_id: appA,
    server_id: serverS,
    container_name: `perm-ctr-${uid()}`,
    host_port: 20001,
    status: "running",
  }).id;

  stackA = db.insertStack({ name: `perm-stack-a-${uid()}`, environment_id: envA }).id;
  db.setAppStack(mkApp(envA), stackA);

  stackX = db.insertStack({ name: `perm-stack-x-${uid()}`, environment_id: envA }).id;
  db.setAppStack(mkApp(envA), stackX);
  db.setAppStack(mkApp(envB), stackX);

  serviceX = db.insertService({
    name: `perm-svc-${uid()}`,
    service_type: "postgres",
    version: "16",
    port: 5432,
    env_vars: "{}",
    credentials: "{}",
  }).id;
}

/** Every id the case table dereferences must still resolve; if any was wiped we
 *  rebuild the whole set rather than trying to patch individual rows. */
function fixturesIntact(): boolean {
  return Boolean(
    appA && db.getApp(appA) &&
    appB && db.getApp(appB) &&
    envA && db.getEnvironment(envA) &&
    envB && db.getEnvironment(envB) &&
    serverS && db.getServer(serverS) &&
    replicaR && db.getReplica(replicaR) &&
    stackA && db.getStack(stackA) &&
    stackX && db.getStack(stackX) &&
    serviceX && db.getService(serviceX),
  );
}

beforeEach(() => {
  if (!fixturesIntact()) seedFleet();
});

// ---------------------------------------------------------------------------
// Bypass guard — must fail loudly if an auth-bypassing stub is still installed
// ---------------------------------------------------------------------------

describe("GUARD: the real permission layer is what the routes see", () => {
  test("the live ../lib/permissions.ts export is the real requirePermission", async () => {
    const live = await import("../lib/permissions.ts");
    expect(live.requirePermission).toBe(realPermissions.requirePermission);
    expect(live.requireAuthenticated).toBe(realPermissions.requireAuthenticated);
    // A bypass stub is an arrow function that ignores its arguments; the real
    // one resolves the user and consults hasPermission.
    expect(live.requirePermission.toString()).toContain("hasPermission");
  });

  test("a user with NO permissions is refused by a known-protected handler", async () => {
    const ctx = await userWith([]);
    const res = await handleDestroyApp(
      req(`/api/apps/${appA}`, { method: "DELETE", token: ctx.token }),
      appA,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Missing permission: apps\.destroy/);
  });

  test("a user with NO permissions is refused by a handler another suite stubs out", async () => {
    const ctx = await userWith([]);
    const res = await handleDeploy(req("/api/apps/deploy", {
      body: { app_name: db.getApp(appA)!.name, apply_mode: "manifest", git_repo: db.getApp(appA)!.git_repo, container_port: 3000 },
      token: ctx.token,
    }));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type Case = {
  /** "<area>: <handler>" — surfaces in every generated test name. */
  name: string;
  /** The permission the route must demand. */
  permission: string;
  /** Grants also needed to *reach* this gate (earlier checks in the handler). */
  extra?: string[];
  /** The route intentionally accepts only CLI-minted tokens. */
  cli?: boolean;
  call: (ctx: Ctx) => Promise<Response>;
  /**
   * Set when the allow-path cannot be reached without live infrastructure
   * (cloud provider API). Only the deny assertions run.
   */
  denyOnly?: string;
};

const CASES: Case[] = [
  // --- apps ----------------------------------------------------------------
  {
    name: "environments: handleGetDeletedEnvironments",
    permission: "environments.view",
    call: (c) => handleGetDeletedEnvironments(req("/api/environments/deleted", { token: c.token })),
  },
  {
    name: "apps: handleGetApps",
    permission: "apps.view",
    call: (c) => handleGetApps(req("/api/apps", { token: c.token })),
  },
  {
    name: "apps: handleGetDashboard",
    permission: "fleet.view",
    call: (c) => handleGetDashboard(req("/api/dashboard", { token: c.token })),
  },
  {
    name: "apps: handleDeploy",
    permission: "apps.deploy",
    extra: ["cli.access"],
    cli: true,
    call: (c) => handleDeploy(req("/api/apps/deploy", {
      body: {
        app_name: db.getApp(appA)!.name,
        apply_mode: "manifest",
        git_repo: db.getApp(appA)!.git_repo,
        container_port: db.getApp(appA)!.container_port,
        deploy: false,
      },
      token: c.token,
    })),
  },
  {
    name: "apps: handleDestroyApp",
    permission: "apps.destroy",
    call: (c) =>
      handleDestroyApp(req(`/api/apps/${appA}`, { method: "DELETE", token: c.token }), appA),
  },
  {
    name: "apps: handleRestartApp",
    permission: "apps.restart",
    call: (c) =>
      handleRestartApp(req(`/api/apps/${appA}/restart`, { body: {}, token: c.token }), appA),
  },
  {
    name: "apps: handlePauseApp",
    permission: "apps.pause",
    call: (c) => handlePauseApp(req(`/api/apps/${appA}/pause`, { body: {}, token: c.token }), appA),
  },
  {
    name: "apps: handleRollbackApp",
    permission: "apps.rollback",
    call: (c) =>
      handleRollbackApp(req(`/api/apps/${appA}/rollback`, { body: {}, token: c.token }), appA),
  },
  {
    name: "apps: handleGetContainerLogs",
    permission: "apps.logs",
    // appB has no replicas, so the handler returns before any ssh.
    call: (c) =>
      handleGetContainerLogs(req(`/api/apps/${appB}/logs`, { token: c.token }), appB),
  },
  {
    name: "apps: handleGetDeployments",
    permission: "deployments.view",
    call: (c) =>
      handleGetDeployments(req(`/api/apps/${appA}/deployments`, { token: c.token }), appA),
  },
  {
    name: "apps: handleGetDeployLog",
    permission: "deployments.view",
    call: (c) => handleGetDeployLog(req(`/api/apps/${appA}/deploy-log`, { token: c.token }), appA),
  },
  // --- stacks ---------------------------------------------------------------
  {
    name: "stacks: handleGetStacks",
    permission: "stacks.view",
    call: (c) => handleGetStacks(req("/api/stacks", { token: c.token })),
  },
  {
    name: "stacks: handleGetStack",
    permission: "stacks.view",
    call: (c) => handleGetStack(req(`/api/stacks/${stackA}`, { token: c.token }), stackA),
  },
  {
    name: "stacks: handleGetStackLog",
    permission: "stacks.view",
    call: (c) => handleGetStackLog(req(`/api/stacks/${stackA}/log`, { token: c.token }), stackA),
  },
  {
    name: "stacks: handleDeployStack",
    permission: "stacks.deploy",
    extra: ["cli.access"],
    cli: true,
    call: (c) => handleDeployStack(req("/api/stacks/deploy", { body: {}, token: c.token })),
  },
  {
    name: "stacks: handleDestroyStack",
    permission: "stacks.destroy",
    call: (c) => {
      const user = { userId: c.userId, username: c.userId };
      const confirmation = createConfirmation(user, "delete_stack", "stack", String(stackA), "test");
      resolveConfirmation(confirmation.userCode, user, "confirmed");
      return handleDestroyStack(
        req(`/api/stacks/${stackA}`, {
          method: "DELETE",
          token: c.token,
          headers: { "x-ocd-confirmation": confirmation.confirmCode },
        }),
        stackA,
      );
    },
  },
  {
    name: "stacks: handlePromoteStack",
    permission: "stacks.promote",
    call: (c) =>
      handlePromoteStack(req(`/api/stacks/${stackA}/promote`, { body: {}, token: c.token }), stackA),
  },

  // --- services -------------------------------------------------------------
  {
    name: "services: handleGetServices",
    permission: "services.view",
    call: (c) => handleGetServices(req("/api/services", { token: c.token })),
  },
  {
    name: "services: handleGetCatalog",
    permission: "services.view",
    call: (c) => handleGetCatalog(req("/api/services/catalog", { token: c.token })),
  },
  {
    name: "services: handleDeployService",
    permission: "services.deploy",
    extra: ["cli.access"],
    cli: true,
    call: (c) => handleDeployService(req("/api/services", { body: {}, token: c.token })),
  },
  {
    name: "services: handleDestroyService",
    permission: "services.destroy",
    call: (c) =>
      handleDestroyService(
        req(`/api/services/${serviceX}`, { method: "DELETE", token: c.token }),
        serviceX,
      ),
  },
  {
    name: "services: handleRestartService",
    permission: "services.manage",
    call: (c) =>
      handleRestartService(
        req(`/api/services/${serviceX}/restart`, { body: {}, token: c.token }),
        serviceX,
      ),
  },
  {
    name: "services: handleInjectService (link gate)",
    permission: "services.link",
    extra: ["environments.secrets"],
    call: (c) =>
      handleInjectService(
        req(`/api/services/${serviceX}/inject/${envA}`, { body: {}, token: c.token }),
        serviceX,
        envA,
      ),
  },
  {
    name: "services: handleInjectService (secrets gate)",
    permission: "environments.secrets",
    extra: ["services.link"],
    call: (c) =>
      handleInjectService(
        req(`/api/services/${serviceX}/inject/${envA}`, { body: {}, token: c.token }),
        serviceX,
        envA,
      ),
  },

  // --- environments ---------------------------------------------------------
  {
    name: "environments: handleGetEnvironments",
    permission: "environments.view",
    call: (c) => handleGetEnvironments(req("/api/environments", { token: c.token })),
  },
  {
    name: "environments: handleGetEnvironmentApps",
    permission: "environments.view",
    call: (c) =>
      handleGetEnvironmentApps(req(`/api/environments/${envA}/apps`, { token: c.token }), envA),
  },
  {
    name: "environments: handleCreateEnvironment",
    permission: "environments.manage",
    call: (c) =>
      handleCreateEnvironment(req("/api/environments", { body: { name: uid() }, token: c.token })),
  },
  {
    name: "environments: handleUpdateEnvironment (rename)",
    permission: "environments.manage",
    call: (c) => {
      const env = db.insertEnvironment(`perm-tmp-${uid()}`, "{}").id;
      return handleUpdateEnvironment(
        req(`/api/environments/${env}`, {
          method: "PUT",
          body: { name: `perm-renamed-${uid()}` },
          token: c.token,
        }),
        env,
      );
    },
  },
  {
    name: "environments: handleUpdateEnvironment (env_vars = secrets)",
    permission: "environments.secrets",
    call: (c) => {
      const env = db.insertEnvironment(`perm-tmp-${uid()}`, "{}").id;
      return handleUpdateEnvironment(
        req(`/api/environments/${env}`, {
          method: "PUT",
          body: { env_vars: [{ key: "A", value: "1" }] },
          token: c.token,
        }),
        env,
      );
    },
  },
  {
    name: "environments: handleDeleteEnvironment",
    permission: "environments.manage",
    call: (c) => {
      const env = db.insertEnvironment(`perm-tmp-${uid()}`, "{}").id;
      const user = { userId: c.userId, username: c.userId };
      const confirmation = createConfirmation(
        user,
        "delete_environment",
        "environment",
        String(env),
        "test",
      );
      resolveConfirmation(confirmation.userCode, user, "confirmed");
      return handleDeleteEnvironment(
        req(`/api/environments/${env}`, {
          method: "DELETE",
          token: c.token,
          headers: { "x-ocd-confirmation": confirmation.confirmCode },
        }),
        env,
      );
    },
  },
  {
    name: "environments: handleRestoreEnvironment",
    permission: "environments.manage",
    denyOnly: "allow path requires a deleted environment fixture",
    call: (c) => handleRestoreEnvironment(
      req("/api/environments/999999/restore", { method: "POST", token: c.token }),
      999999,
    ),
  },
  {
    name: "environments: handlePurgeEnvironment",
    permission: "environments.manage",
    denyOnly: "allow path requires a deleted environment and confirmation fixture",
    call: (c) => handlePurgeEnvironment(
      req("/api/environments/999999/purge", { method: "DELETE", token: c.token }),
      999999,
    ),
  },
  // --- scaling --------------------------------------------------------------
  {
    name: "scaling: handleWakeApp",
    permission: "apps.restart",
    call: (c) =>
      handleWakeApp(
        req(`/api/apps/${appA}/wake`, { body: {}, token: c.token }),
        appA,
      ),
  },
  {
    name: "scaling: handleMigrateReplica",
    permission: "scaling.migrate",
    call: (c) =>
      handleMigrateReplica(
        req(`/api/apps/${appA}/replicas/${replicaR}/migrate`, { body: {}, token: c.token }),
        appA,
        replicaR,
      ),
  },
  {
    name: "scaling: handleGetReplicas",
    permission: "metrics.view",
    call: (c) => handleGetReplicas(req(`/api/apps/${appA}/replicas`, { token: c.token }), appA),
  },

  // --- volumes --------------------------------------------------------------
  {
    name: "volumes: handleListVolumeFiles",
    permission: "volumes.files.read",
    call: (c) =>
      handleListVolumeFiles(req("/api/volumes/nope/files", { token: c.token }), "nope"),
  },

  // --- servers --------------------------------------------------------------
  {
    name: "servers: handleGetServers",
    permission: "fleet.view",
    call: (c) => handleGetServers(req("/api/servers", { token: c.token })),
  },
  {
    name: "servers: handleDeleteServer",
    permission: "servers.delete",
    call: (c) => {
      const srv = db.insertServer({
        name: `perm-tmp-srv-${uid()}`,
        provider_id: `hz-${uid()}`,
        ipv4: "203.0.113.8",
        ipv6: "",
        type: "cx22",
        location: "fsn1",
        status: "running",
      }).id;
      return handleDeleteServer(
        req(`/api/servers/${srv}`, { method: "DELETE", token: c.token }),
        srv,
      );
    },
  },
  {
    name: "servers: handleSetServerPool",
    permission: "servers.manage",
    call: (c) =>
      handleSetServerPool(
        req(`/api/servers/${serverS}/pool`, {
          method: "PATCH",
          body: { pool: "general" },
          token: c.token,
        }),
        serverS,
      ),
  },
  {
    name: "resources: handleCreateServer",
    permission: "servers.create",
    call: (c) =>
      handleCreateServer(
        req("/api/servers", { body: { server_type: "cx22", location: "fsn1" }, token: c.token }),
      ),
  },

  // --- resources ------------------------------------------------------------
  {
    name: "resources: handleGetResources",
    permission: "resources.view",
    denyOnly: "the allow path calls the Hetzner API for pricing and inventory",
    call: (c) => handleGetResources(req("/api/resources", { token: c.token })),
  },
  {
    name: "resources: handleDeleteResource (generic)",
    permission: "resources.delete",
    denyOnly: "the allow path issues a real provider delete",
    call: (c) =>
      handleDeleteResource(
        req("/api/resources/floating-ip/x", { method: "DELETE", token: c.token }),
        "floating-ip",
        "x",
      ),
  },
  {
    name: "resources: handleDeleteResource (volume)",
    permission: "volumes.delete",
    denyOnly: "the allow path issues a real provider delete",
    call: (c) =>
      handleDeleteResource(
        req("/api/resources/volume/x", { method: "DELETE", token: c.token }),
        "volume",
        "x",
      ),
  },
  {
    name: "resources: handleGetVolumeDeletionAudit",
    permission: "volumes.delete",
    call: (c) => handleGetVolumeDeletionAudit(req("/api/resources/volumes/deletion-audit", { token: c.token })),
  },

  // --- operations -----------------------------------------------------------
  {
    name: "operations: handleListOperations",
    permission: "operations.view",
    call: (c) => handleListOperations(req("/api/operations", { token: c.token })),
  },
  {
    name: "operations: handleCancelOperation",
    permission: "operations.cancel",
    // The op is triggered by the caller, so the "another user's operation"
    // check cannot masquerade as a permission failure.
    call: (c) => {
      const op = enqueueOperation({
        kind: "restart_app",
        resourceKeys: [`app:${appA}`],
        input: { appId: appA },
        trigger: "ui",
        triggeredBy: c.userId,
      });
      return handleCancelOperation(
        req(`/api/operations/${op.id}/cancel`, { body: {}, token: c.token }),
        op.id,
      );
    },
  },

  // --- panel ----------------------------------------------------------------
  {
    name: "panel: handleGetPanel",
    permission: "panel.view",
    call: (c) => handleGetPanel(req("/api/panel", { token: c.token })),
  },
  {
    name: "panel: handleRedeployPanel",
    permission: "panel.manage",
    call: (c) => handleRedeployPanel(req("/api/panel/redeploy", { body: {}, token: c.token })),
  },

  // --- webhooks -------------------------------------------------------------
  {
    name: "webhooks: handleEnablePanelWebhook",
    permission: "panel.manage",
    call: (c) => handleEnablePanelWebhook(req("/api/panel/webhook", { body: {}, token: c.token })),
  },
  {
    name: "webhooks: handleDisablePanelWebhook",
    permission: "panel.manage",
    call: (c) =>
      handleDisablePanelWebhook(
        req("/api/panel/webhook", { method: "DELETE", token: c.token }),
      ),
  },

  // --- terminal -------------------------------------------------------------
  {
    name: "terminal-exec: host shell",
    permission: "terminal.host",
    call: (c) =>
      handleTerminalExec(
        req("/api/terminal/exec", {
          body: { target: `server:${serverS}`, command: "echo hi" },
          token: c.token,
        }),
      ),
  },
  {
    name: "terminal-exec: container shell",
    permission: "terminal.container",
    call: (c) =>
      handleTerminalExec(
        req("/api/terminal/exec", {
          body: { target: `replica:${replicaR}`, command: "echo hi" },
          token: c.token,
        }),
      ),
  },
];

/** Every permission except the ones this case legitimately needs. */
function everyPermissionExcept(c: Case): string[] {
  const needed = new Set([c.permission, ...(c.extra ?? [])]);
  // Keep the extras: they are prerequisites for *reaching* the gate under test.
  const keep = new Set(c.extra ?? []);
  return (ALL_PERMISSIONS as readonly string[]).filter(
    (p) => keep.has(p) || !needed.has(p),
  );
}

describe.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
  test(`401 without an Authorization header [${c.name}]`, async () => {
    const res = await c.call({ token: "", userId: "nobody" });
    expect(res.status).toBe(401);
  });

  test(`401 with a malformed token [${c.name}]`, async () => {
    const res = await c.call({ token: "not.a.jwt", userId: "nobody" });
    expect(res.status).toBe(401);
  });

  test(`403 for an authenticated user holding no permissions [${c.name}]`, async () => {
    const ctx = await userWith([], { cli: c.cli });
    const res = await c.call(ctx);
    expect(res.status).toBe(403);
  });

  test(`403 holding every permission EXCEPT ${c.permission} [${c.name}]`, async () => {
    const ctx = await userWith(everyPermissionExcept(c), { cli: c.cli });
    const res = await c.call(ctx);
    expect(res.status).toBe(403);
  });

  if (!c.denyOnly) {
    test(`NOT 403 once ${c.permission} is granted [${c.name}]`, async () => {
      const ctx = await userWith([c.permission, ...(c.extra ?? [])], { cli: c.cli });
      const res = await c.call(ctx);
      expect(res.status).not.toBe(403);
    });

    test(`NOT 403 for an admin holding no grants at all [${c.name}]`, async () => {
      const ctx = await userWith([], { admin: true, cli: c.cli });
      const res = await c.call(ctx);
      expect(res.status).not.toBe(403);
    });
  } else {
    test.skip(`allow path not exercised: ${c.denyOnly} [${c.name}]`, () => {});
  }
});

// ---------------------------------------------------------------------------
// Scope semantics, end to end
// ---------------------------------------------------------------------------

describe("scope semantics through the real routes", () => {
  test("an app-scoped grant acts on THAT app and is refused on another", async () => {
    const ctx = await userWith([grant("apps.restart", "app", appA)]);

    const ok = await handleRestartApp(
      req(`/api/apps/${appA}/restart`, { body: {}, token: ctx.token }),
      appA,
    );
    expect(ok.status).not.toBe(403);

    const denied = await handleRestartApp(
      req(`/api/apps/${appB}/restart`, { body: {}, token: ctx.token }),
      appB,
    );
    expect(denied.status).toBe(403);
  });

  test("an environment-scoped grant covers apps inside it and nothing outside", async () => {
    const ctx = await userWith([grant("apps.restart", "environment", envA)]);

    const ok = await handleRestartApp(
      req(`/api/apps/${appA}/restart`, { body: {}, token: ctx.token }),
      appA,
    );
    expect(ok.status).not.toBe(403);

    const denied = await handleRestartApp(
      req(`/api/apps/${appB}/restart`, { body: {}, token: ctx.token }),
      appB,
    );
    expect(denied.status).toBe(403);
  });

  test("an app-scoped grant does NOT satisfy a route that checks unscoped", async () => {
    const ctx = await userWith([grant("apps.view", "app", appA)]);
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).toBe(403);
  });

  test("an environment-scoped grant satisfies a stack whose members share it", async () => {
    const ctx = await userWith([grant("stacks.view", "environment", envA)]);
    const res = await handleGetStack(req(`/api/stacks/${stackA}`, { token: ctx.token }), stackA);
    expect(res.status).not.toBe(403);
  });

  test("an environment-scoped grant is refused on a stack that spans two environments", async () => {
    const ctx = await userWith([grant("stacks.view", "environment", envA)]);
    const res = await handleGetStack(req(`/api/stacks/${stackX}`, { token: ctx.token }), stackX);
    expect(res.status).toBe(403);
  });

  test("an environment-scoped secrets grant is refused on a different environment", async () => {
    const ctx = await userWith([grant("environments.secrets", "environment", envA)]);
    const res = await handleUpdateEnvironment(
      req(`/api/environments/${envB}`, {
        method: "PUT",
        body: { env_vars: [{ key: "A", value: "1" }] },
        token: ctx.token,
      }),
      envB,
    );
    expect(res.status).toBe(403);
  });

  test("environment dry-run reports stale consumers before mutating desired state", async () => {
    const ctx = await userWith([grant("environments.secrets", "environment", envA)]);
    const before = db.getEnvironment(envA)!.env_vars;
    const res = await handleUpdateEnvironment(
      req(`/api/environments/${envA}`, {
        method: "PUT",
        body: {
          env_vars: [{ key: "PREVIEW_ONLY", value: "1", secret: false }],
          rollout: "none",
          dry_run: true,
        },
        token: ctx.token,
      }),
      envA,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.dry_run).toBe(true);
    expect(body.stale_apps.map((app: any) => app.id)).toContain(appA);
    expect(db.getEnvironment(envA)!.env_vars).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Previously-conflated permissions must stay split
// ---------------------------------------------------------------------------

describe("permission splits are enforced (the old coarse grant is not enough)", () => {
  test("apps.redeploy does NOT allow changing stored configuration", async () => {
    const ctx = await userWith(["apps.redeploy", "cli.access"], { cli: true });
    const res = await handleDeploy(req("/api/apps/deploy", {
      body: { app_name: db.getApp(appA)!.name, apply_mode: "manifest", git_repo: db.getApp(appA)!.git_repo, container_port: 3000, sticky: true },
      token: ctx.token,
    }));
    expect(res.status).toBe(403);
  });

  test("apps.ingress does NOT allow changing stored configuration", async () => {
    const ctx = await userWith(["apps.ingress", "cli.access"], { cli: true });
    const res = await handleDeploy(req("/api/apps/deploy", {
      body: { app_name: db.getApp(appA)!.name, apply_mode: "manifest", git_repo: db.getApp(appA)!.git_repo, container_port: 3000, sticky: true },
      token: ctx.token,
    }));
    expect(res.status).toBe(403);
  });

  test("apps.logs does NOT grant deploy history (needs deployments.view)", async () => {
    const ctx = await userWith(["apps.logs"]);

    const logs = await handleGetContainerLogs(
      req(`/api/apps/${appB}/logs`, { token: ctx.token }),
      appB,
    );
    expect(logs.status).not.toBe(403);

    const deployments = await handleGetDeployments(
      req(`/api/apps/${appA}/deployments`, { token: ctx.token }),
      appA,
    );
    expect(deployments.status).toBe(403);

    const deployLog = await handleGetDeployLog(
      req(`/api/apps/${appA}/deploy-log`, { token: ctx.token }),
      appA,
    );
    expect(deployLog.status).toBe(403);
  });

  test("webhooks.manage neither mutates app config nor changes the panel webhook", async () => {
    const ctx = await userWith(["webhooks.manage", "cli.access"], { cli: true });

    const appLevel = await handleDeploy(req("/api/apps/deploy", {
      body: {
        app_name: db.getApp(appA)!.name,
        apply_mode: "manifest",
        git_repo: db.getApp(appA)!.git_repo,
        container_port: 3000,
        webhook_wait_for_ci: true,
      },
      token: ctx.token,
    }));
    expect(appLevel.status).toBe(403);

    const enable = await handleEnablePanelWebhook(
      req("/api/panel/webhook", { body: {}, token: ctx.token }),
    );
    expect(enable.status).toBe(403);

    const disable = await handleDisablePanelWebhook(
      req("/api/panel/webhook", { method: "DELETE", token: ctx.token }),
    );
    expect(disable.status).toBe(403);
  });

  test("servers.delete does NOT allow pool assignment (needs servers.manage)", async () => {
    const ctx = await userWith(["servers.delete"]);
    const res = await handleSetServerPool(
      req(`/api/servers/${serverS}/pool`, {
        method: "PATCH",
        body: { pool: "general" },
        token: ctx.token,
      }),
      serverS,
    );
    expect(res.status).toBe(403);
  });

  test("apps.redeploy does NOT allow redeploying the control plane (needs panel.manage)", async () => {
    const ctx = await userWith(["apps.redeploy"]);
    const res = await handleRedeployPanel(
      req("/api/panel/redeploy", { body: {}, token: ctx.token }),
    );
    expect(res.status).toBe(403);
  });

  test("terminal.container does NOT grant a host shell", async () => {
    const ctx = await userWith(["terminal.container"]);

    const container = await handleTerminalExec(
      req("/api/terminal/exec", {
        body: { target: `replica:${replicaR}`, command: "echo hi" },
        token: ctx.token,
      }),
    );
    expect(container.status).not.toBe(403);

    const host = await handleTerminalExec(
      req("/api/terminal/exec", {
        body: { target: `server:${serverS}`, command: "echo hi" },
        token: ctx.token,
      }),
    );
    expect(host.status).toBe(403);
  });

  test("environments.manage does NOT grant reading/writing env var values", async () => {
    const ctx = await userWith(["environments.manage"]);
    const env = db.insertEnvironment(`perm-tmp-${uid()}`, "{}").id;

    const rename = await handleUpdateEnvironment(
      req(`/api/environments/${env}`, {
        method: "PUT",
        body: { name: `perm-renamed-${uid()}` },
        token: ctx.token,
      }),
      env,
    );
    expect(rename.status).not.toBe(403);

    const secrets = await handleUpdateEnvironment(
      req(`/api/environments/${env}`, {
        method: "PUT",
        body: { env_vars: [{ key: "A", value: "1" }] },
        token: ctx.token,
      }),
      env,
    );
    expect(secrets.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// cli.access
// ---------------------------------------------------------------------------

describe("deploy entry points are CLI-only", () => {
  test("a browser token cannot apply a stack manifest", async () => {
    const ctx = await userWith(["stacks.deploy"]);
    const res = await handleDeployStack(
      req("/api/stacks/deploy", { body: {}, token: ctx.token }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/only available through the ocd CLI/i);
  });

  test("a browser token cannot deploy a managed service", async () => {
    const ctx = await userWith(["services.deploy"]);
    const res = await handleDeployService(
      req("/api/services", { body: {}, token: ctx.token }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/only available through the ocd CLI/i);
  });
});

describe("cli.access gates CLI-minted tokens on every route", () => {
  test("a CLI token is refused even when the user holds the needed permission", async () => {
    const ctx = await userWith(["apps.view"], { cli: true });
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/CLI access is not enabled/i);
  });

  test("the same CLI token is accepted once cli.access is granted", async () => {
    const ctx = await userWith(["apps.view", "cli.access"], { cli: true });
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).not.toBe(403);
  });

  test("cli.access alone still does not grant the permission", async () => {
    const ctx = await userWith(["cli.access"], { cli: true });
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).toBe(403);
  });

  test("a non-CLI token is unaffected by a missing cli.access", async () => {
    const ctx = await userWith(["apps.view"]);
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).not.toBe(403);
  });

  test("an admin CLI token is never blocked", async () => {
    const ctx = await userWith([], { admin: true, cli: true });
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).not.toBe(403);
  });

  test("cli.access is also enforced on requireAuthenticated routes", async () => {
    const ctx = await userWith(["environments.manage", "environments.secrets"], { cli: true });
    const env = db.insertEnvironment(`perm-tmp-${uid()}`, "{}").id;
    const res = await handleUpdateEnvironment(
      req(`/api/environments/${env}`, {
        method: "PUT",
        body: { name: `perm-renamed-${uid()}` },
        token: ctx.token,
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Deleted / revoked identities
// ---------------------------------------------------------------------------

describe("identity checks", () => {
  test("a valid token for a deleted user is 401, not a silent pass", async () => {
    const ctx = await userWith(["apps.view"]);
    db.deleteUser(ctx.userId);
    const res = await handleGetApps(req("/api/apps", { token: ctx.token }));
    expect(res.status).toBe(401);
  });

  test("a token minted before a token_version bump is rejected", async () => {
    const id = uid();
    db.insertUser({ id, username: id, password_hash: "x" });
    db.setUserPermissions(id, ["apps.view"]);
    const token = await createToken({ userId: id, username: id, v: 0 });
    db.incrementTokenVersion(id);
    const res = await handleGetApps(req("/api/apps", { token }));
    expect(res.status).toBe(401);
  });
});
