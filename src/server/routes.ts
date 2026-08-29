import { handleSetupStatus, handleSetupComplete } from "./routes/setup.ts";
import { handleLogin, handleMe, handleUpdateMe } from "./routes/auth.ts";
import {
  handleWebAuthnRegisterOptions,
  handleWebAuthnRegisterVerify,
  handleWebAuthnRegisterOptionsFromLogin,
  handleWebAuthnRegisterVerifyFromLogin,
  handleWebAuthnLoginOptions,
  handleWebAuthnLoginVerify,
  handleWebAuthnList,
  handleWebAuthnDelete,
  handlePasswordResetWebAuthnOptions,
  handlePasswordResetWebAuthnVerify,
} from "./routes/webauthn.ts";
import { handleListUsers, handleCreateUser, handleUpdateUser, handleDeleteUser, handleGetUserPermissions } from "./routes/admin.ts";
import {
  handleGetServers,
  handleGetDashboard,
  handleGetApps,
  handleDeploy,
  handleRedeployApp,
  handleReleaseApp,
  handleDestroyApp,
  handleRestartApp,
  handleReloadAppEnvironment,
  handlePauseApp,
  handleUnpauseApp,
  handleGetContainerLogs,
  handleGetDeployLog,
  handleGetDeployments,
  handleRollbackApp,
  handlePromoteApp,
  handleGetAppStaging,
} from "./routes/apps.ts";
import { handleConnectServer, handleDeleteServer, handleGetServerEnrollmentKey, handleRefreshServers, handleSetServerPool } from "./routes/servers.ts";
import { handleGetSettings, handleSaveSettings, handleGetServerTypes } from "./routes/settings.ts";
import { handleGetResources, handleGetServerMetricsHistory, handleDeleteResource, handleCreateServer, handleGetVolumeDetail, handleListVolumeFiles, handleGetVolumeFile, handleGetServerDetail, handleGetVolumeDeletionAudit } from "./routes/resources.ts";
import { handleWakeApp, handleGetReplicas, handleGetScalingEvents, handleGetAppMetrics, handleGetAppMetricsHistory, handleMigrateReplica } from "./routes/scaling.ts";
import { handleGetAvailability } from "./routes/availability.ts";
import {
  handleGetPanel,
  handleRedeployPanel,
  handleGetPanelLogs,
  handleGetPanelDeployments,
} from "./routes/panel.ts";
import {
  handleGitHubAuthorize,
  handleGitHubCallback,
  handleGitHubUnlink,
  handleGitHubStatus,
} from "./routes/github-oauth.ts";
import { handleDeviceCode, handleDeviceToken, handleDeviceConfirm } from "./routes/device-auth.ts";
import { handleCreateConfirmation, handlePollConfirmation, handleLookupConfirmation, handleConfirmConfirmation, handleDenyConfirmation } from "./routes/confirmations.ts";
import { handleCliInstallSh, handleCliDownload } from "./routes/cli.ts";
import { handleCliActionRun } from "./routes/web-cli.ts";
import {
  handleGetEnvironments,
  handleGetDeletedEnvironments,
  handleCreateEnvironment,
  handleUpdateEnvironment,
  handleCopyEnvironment,
  handleDeleteEnvironment,
  handleRestoreEnvironment,
  handlePurgeEnvironment,
  handleGetEnvironmentApps,
} from "./routes/environments.ts";
import {
  handleListOperations,
  handleGetOperation,
  handleOperationEvents,
  handleGetOperationLogs,
  handleCancelOperation,
  handleRetryOperation,
  handleFinalizeOperation,
} from "./routes/operations.ts";
import { handleTerminalExec } from "./routes/terminal-exec.ts";
import { handleInternalWake } from "./routes/internal.ts";
import {
  handleGetCatalog,
  handleGetServices,
  handleGetService,
  handleDeployService,
  handleDestroyService,
  handleRestartService,
  handlePauseService,
  handleUnpauseService,
  handleGetServiceLogs,
  handleInjectService,
  handleUninjectService,
} from "./routes/services.ts";
import {
  handleDeployStack,
  handleGetStacks,
  handleGetStack,
  handleGetStackLog,
  handleGetStackMemberLogs,
  handleDestroyStack,
  handlePromoteStack,
} from "./routes/stacks.ts";
import { VERSION } from "../shared/version.ts";
import { handleGcExecute, handleGcInventory } from "./routes/gc.ts";
import { handleGetAppStorage } from "./routes/app-storage.ts";
import {
  handleGetBuildWorkers,
  handleInstallBuildWorker,
  handleRemoveBuildWorker,
  handleGetBuildSources,
  handleRotateBuildSourceWebhook,
} from "./routes/build-workers.ts";
import { handleGitHubBuildWebhook } from "./routes/build-webhooks.ts";
import { handleGetProvisioningDefaults } from "./lib/server-provisioning.ts";

function appIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/apps\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function replicaIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/replicas\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function userIdFrom(req: Request): string {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/admin\/users\/([^/]+)/);
  return match ? match[1] : "";
}

function serverIdFrom(req: Request): number {
  const url = new URL(req.url);
  return parseInt(url.pathname.split("/").pop()!, 10);
}

function serverPathIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/servers\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function runnerIdFrom(req: Request): number {
  const match = new URL(req.url).pathname.match(/\/api\/runners\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function buildSourceIdFrom(req: Request): number {
  const match = new URL(req.url).pathname.match(/\/api\/build-sources\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function webhookBuildSourceIdFrom(req: Request): number {
  const match = new URL(req.url).pathname.match(/\/webhooks\/github\/build\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function resourcePartsFrom(req: Request): { type: string; id: string } {
  const parts = new URL(req.url).pathname.split("/");
  return { type: parts[3], id: parts[4] };
}

function serviceIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/services\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function serviceInjectPartsFrom(req: Request): { serviceId: number; environmentId: number } {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/services\/(\d+)\/inject\/(\d+)/);
  return match ? { serviceId: parseInt(match[1], 10), environmentId: parseInt(match[2], 10) } : { serviceId: 0, environmentId: 0 };
}

function environmentIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/environments\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function stackIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/stacks\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function confirmationCodeFrom(req: Request): string {
  const url = new URL(req.url);
  const m = url.pathname.match(/\/api\/confirmations\/item\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}


export const apiRoutes = {
  // --- Health probe (public, used by Docker HEALTHCHECK and reverse proxies) ---
  "/api/health": {
    GET: () =>
      new Response(JSON.stringify({ ok: true, version: VERSION }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },

  // --- CLI distribution (public) ---
  "/cli/install.sh": { GET: (req: Request) => handleCliInstallSh(req) },
  "/cli/:binary": { GET: (req: Request) => handleCliDownload(req) },
  "/webhooks/github/build/:id": { POST: (req: Request) => handleGitHubBuildWebhook(req, webhookBuildSourceIdFrom(req)) },

  // --- Purpose-built browser actions; executes the actual allowlisted OCD CLI ---
  "/api/cli-actions/run": { POST: (req: Request) => handleCliActionRun(req) },

  // --- Setup ---
  "/api/setup/status": { GET: (req: Request) => handleSetupStatus(req) },
  "/api/setup/complete": { POST: (req: Request) => handleSetupComplete(req) },

  // --- Auth ---
  "/api/auth/login": { POST: (req: Request) => handleLogin(req) },
  "/api/auth/device-code": { POST: () => handleDeviceCode() },
  "/api/auth/device-token": { POST: (req: Request) => handleDeviceToken(req) },
  "/api/auth/device-confirm": { POST: (req: Request) => handleDeviceConfirm(req) },

  // --- Web action confirmations (browser-gated destructive CLI actions) ---
  "/api/confirmations": { POST: (req: Request) => handleCreateConfirmation(req) },
  "/api/confirmations/poll": { POST: (req: Request) => handlePollConfirmation(req) },
  "/api/confirmations/item/:userCode": { GET: (req: Request) => handleLookupConfirmation(req, confirmationCodeFrom(req)) },
  "/api/confirmations/item/:userCode/confirm": { POST: (req: Request) => handleConfirmConfirmation(req, confirmationCodeFrom(req)) },
  "/api/confirmations/item/:userCode/deny": { POST: (req: Request) => handleDenyConfirmation(req, confirmationCodeFrom(req)) },
  "/api/auth/password-reset/webauthn-options": { POST: (req: Request) => handlePasswordResetWebAuthnOptions(req) },
  "/api/auth/password-reset/webauthn-verify": { POST: (req: Request) => handlePasswordResetWebAuthnVerify(req) },
  "/api/me": {
    GET: (req: Request) => handleMe(req),
    PUT: (req: Request) => handleUpdateMe(req),
  },

  // --- GitHub OAuth ---
  "/api/auth/github/authorize": { GET: (req: Request) => handleGitHubAuthorize(req) },
  "/api/auth/github/callback": { GET: (req: Request) => handleGitHubCallback(req) },
  "/api/auth/github/unlink": { POST: (req: Request) => handleGitHubUnlink(req) },
  "/api/auth/github/status": { GET: (req: Request) => handleGitHubStatus(req) },

  // --- WebAuthn ---
  "/api/auth/webauthn/register-options": { POST: (req: Request) => handleWebAuthnRegisterOptions(req) },
  "/api/auth/webauthn/register-verify": { POST: (req: Request) => handleWebAuthnRegisterVerify(req) },
  "/api/auth/webauthn/register-options-from-login": { POST: (req: Request) => handleWebAuthnRegisterOptionsFromLogin(req) },
  "/api/auth/webauthn/register-verify-from-login": { POST: (req: Request) => handleWebAuthnRegisterVerifyFromLogin(req) },
  "/api/auth/webauthn/login-options": { POST: (req: Request) => handleWebAuthnLoginOptions(req) },
  "/api/auth/webauthn/login-verify": { POST: (req: Request) => handleWebAuthnLoginVerify(req) },
  "/api/auth/webauthn/credentials": { GET: (req: Request) => handleWebAuthnList(req) },
  "/api/auth/webauthn/delete": { POST: (req: Request) => handleWebAuthnDelete(req) },

  // --- Admin ---
  "/api/admin/users": {
    GET: (req: Request) => handleListUsers(req),
    POST: (req: Request) => handleCreateUser(req),
  },
  "/api/admin/users/:userId": {
    PUT: (req: Request) => handleUpdateUser(req, userIdFrom(req)),
    DELETE: (req: Request) => handleDeleteUser(req, userIdFrom(req)),
  },
  "/api/admin/users/:userId/permissions": {
    GET: (req: Request) => handleGetUserPermissions(req, userIdFrom(req)),
  },

  // --- Dashboard ---
  "/api/dashboard": { GET: (req: Request) => handleGetDashboard(req) },

  // --- Servers ---
  "/api/servers": { GET: (req: Request) => handleGetServers(req) },
  "/api/servers/refresh": { POST: (req: Request) => handleRefreshServers(req) },
  "/api/servers/enrollment-key": { GET: (req: Request) => handleGetServerEnrollmentKey(req) },
  "/api/servers/provisioning-defaults": { GET: (req: Request) => handleGetProvisioningDefaults(req) },
  "/api/servers/connect": { POST: (req: Request) => handleConnectServer(req) },
  "/api/servers/:id": { DELETE: (req: Request) => handleDeleteServer(req, serverIdFrom(req)) },
  "/api/servers/:id/pool": { PATCH: (req: Request) => handleSetServerPool(req, serverPathIdFrom(req)) },
  "/api/runners": {
    GET: (req: Request) => handleGetBuildWorkers(req),
    POST: (req: Request) => handleInstallBuildWorker(req),
  },
  "/api/runners/:id": { DELETE: (req: Request) => handleRemoveBuildWorker(req, runnerIdFrom(req)) },
  "/api/build-sources": { GET: (req: Request) => handleGetBuildSources(req) },
  "/api/build-sources/:id/webhook-secret": { POST: (req: Request) => handleRotateBuildSourceWebhook(req, buildSourceIdFrom(req)) },
  "/api/gc": {
    GET: (req: Request) => handleGcInventory(req),
    POST: (req: Request) => handleGcExecute(req),
  },

  // --- Apps ---
  "/api/apps": { GET: (req: Request) => handleGetApps(req) },
  "/api/apps/deploy": { POST: (req: Request) => handleDeploy(req) },
  "/api/apps/promote": { POST: (req: Request) => handlePromoteApp(req) },

  // App-specific
  "/api/apps/:appId": { DELETE: (req: Request) => handleDestroyApp(req, appIdFrom(req)) },
  "/api/apps/:appId/restart": { POST: (req: Request) => handleRestartApp(req, appIdFrom(req)) },
  "/api/apps/:appId/redeploy": { POST: (req: Request) => handleRedeployApp(req, appIdFrom(req)) },
  "/api/apps/:appId/release": { POST: (req: Request) => handleReleaseApp(req, appIdFrom(req)) },
  "/api/apps/:appId/reload-env": { POST: (req: Request) => handleReloadAppEnvironment(req, appIdFrom(req)) },
  "/api/apps/:appId/pause": { POST: (req: Request) => handlePauseApp(req, appIdFrom(req)) },
  "/api/apps/:appId/unpause": { POST: (req: Request) => handleUnpauseApp(req, appIdFrom(req)) },
  "/api/apps/:appId/logs": { GET: (req: Request) => handleGetContainerLogs(req, appIdFrom(req)) },
  "/api/apps/:appId/deploy-log": { GET: (req: Request) => handleGetDeployLog(req, appIdFrom(req)) },
  "/api/apps/:appId/deployments": { GET: (req: Request) => handleGetDeployments(req, appIdFrom(req)) },
  "/api/apps/:appId/rollback": { POST: (req: Request) => handleRollbackApp(req, appIdFrom(req)) },
  "/api/apps/:appId/staging": { GET: (req: Request) => handleGetAppStaging(req, appIdFrom(req)) },
  "/api/apps/:appId/storage": { GET: (req: Request) => handleGetAppStorage(req, appIdFrom(req)) },

  // Scaling
  "/api/apps/:appId/wake": { POST: (req: Request) => handleWakeApp(req, appIdFrom(req)) },
  "/api/apps/:appId/replicas": { GET: (req: Request) => handleGetReplicas(req, appIdFrom(req)) },
  "/api/apps/:appId/replicas/:replicaId/migrate": { POST: (req: Request) => handleMigrateReplica(req, appIdFrom(req), replicaIdFrom(req)) },
  "/api/apps/:appId/scaling-events": { GET: (req: Request) => handleGetScalingEvents(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics": { GET: (req: Request) => handleGetAppMetrics(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics/history": { GET: (req: Request) => handleGetAppMetricsHistory(req, appIdFrom(req)) },
  "/api/apps/:appId/availability": { GET: (req: Request) => handleGetAvailability(req, appIdFrom(req)) },

  // Fleet-internal: ocd-proxy wake endpoint (shared-secret auth, no user token)
  "/api/internal/wake": { POST: (req: Request) => handleInternalWake(req) },

  // (Wake is now transparent: sleeping apps' Traefik routers point at the
  // in-process hold-and-forward waker — see src/engine/scale/waker.ts. There is
  // no browser wake page or token dance. Explicit wake actions use the
  // dedicated operational endpoint and never mutate desired app config.)

  // --- Admin: Settings ---
  "/api/admin/settings": {
    GET: (req: Request) => handleGetSettings(req),
    PUT: (req: Request) => handleSaveSettings(req),
  },
  "/api/admin/settings/server-types": { GET: (req: Request) => handleGetServerTypes(req) },

  // --- Admin: Panel (hosted self) ---
  "/api/admin/panel": { GET: (req: Request) => handleGetPanel(req) },
  "/api/admin/panel/redeploy": { POST: (req: Request) => handleRedeployPanel(req) },
  "/api/admin/panel/logs": { GET: (req: Request) => handleGetPanelLogs(req) },
  "/api/admin/panel/deployments": { GET: (req: Request) => handleGetPanelDeployments(req) },

  // --- Resources ---
  "/api/resources": { GET: (req: Request) => handleGetResources(req) },
  "/api/resources/servers": { POST: (req: Request) => handleCreateServer(req) },
  "/api/resources/metrics/history": { GET: (req: Request) => handleGetServerMetricsHistory(req) },
  "/api/resources/volumes/deletion-audit": {
    GET: (req: Request) => handleGetVolumeDeletionAudit(req),
  },
  "/api/resources/servers/:id": {
    GET: (req: Request) => {
      const id = parseInt(new URL(req.url).pathname.split("/")[4], 10);
      return handleGetServerDetail(req, id);
    },
  },
  "/api/resources/volumes/:id": {
    GET: (req: Request) => {
      const id = new URL(req.url).pathname.split("/")[4];
      return handleGetVolumeDetail(req, id);
    },
  },
  "/api/resources/volumes/:id/files": {
    GET: (req: Request) => {
      const id = new URL(req.url).pathname.split("/")[4];
      return handleListVolumeFiles(req, id);
    },
  },
  "/api/resources/volumes/:id/file": {
    GET: (req: Request) => {
      const id = new URL(req.url).pathname.split("/")[4];
      return handleGetVolumeFile(req, id);
    },
  },
  "/api/resources/:type/:id": {
    DELETE: (req: Request) => {
      const { type, id } = resourcePartsFrom(req);
      return handleDeleteResource(req, type, id);
    },
  },

  // --- Infrastructure Services ---
  "/api/services": { GET: (req: Request) => handleGetServices(req) },
  "/api/services/catalog": { GET: (req: Request) => handleGetCatalog(req) },
  "/api/services/deploy": { POST: (req: Request) => handleDeployService(req) },
  "/api/services/:id": {
    GET: (req: Request) => handleGetService(req, serviceIdFrom(req)),
    DELETE: (req: Request) => handleDestroyService(req, serviceIdFrom(req)),
  },
  "/api/services/:id/restart": { POST: (req: Request) => handleRestartService(req, serviceIdFrom(req)) },
  "/api/services/:id/pause": { POST: (req: Request) => handlePauseService(req, serviceIdFrom(req)) },
  "/api/services/:id/unpause": { POST: (req: Request) => handleUnpauseService(req, serviceIdFrom(req)) },
  "/api/services/:id/logs": { GET: (req: Request) => handleGetServiceLogs(req, serviceIdFrom(req)) },
  "/api/services/:id/inject/:envId": {
    POST: (req: Request) => {
      const { serviceId, environmentId } = serviceInjectPartsFrom(req);
      return handleInjectService(req, serviceId, environmentId);
    },
    DELETE: (req: Request) => {
      const { serviceId, environmentId } = serviceInjectPartsFrom(req);
      return handleUninjectService(req, serviceId, environmentId);
    },
  },

  // --- Environments ---
  "/api/environments": {
    GET: (req: Request) => handleGetEnvironments(req),
    POST: (req: Request) => handleCreateEnvironment(req),
  },
  "/api/environments/deleted": {
    GET: (req: Request) => handleGetDeletedEnvironments(req),
  },
  "/api/environments/:id": {
    PUT: (req: Request) => handleUpdateEnvironment(req, environmentIdFrom(req)),
    DELETE: (req: Request) => handleDeleteEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/copy": {
    POST: (req: Request) => handleCopyEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/restore": {
    POST: (req: Request) => handleRestoreEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/purge": {
    DELETE: (req: Request) => handlePurgeEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/apps": {
    GET: (req: Request) => handleGetEnvironmentApps(req, environmentIdFrom(req)),
  },

  // --- Stacks ---
  "/api/stacks": {
    GET: (req: Request) => handleGetStacks(req),
    POST: (req: Request) => handleDeployStack(req),
  },
  "/api/stacks/:id": {
    GET: (req: Request) => handleGetStack(req, stackIdFrom(req)),
    DELETE: (req: Request) => handleDestroyStack(req, stackIdFrom(req)),
  },
  "/api/stacks/:id/promote": {
    POST: (req: Request) => handlePromoteStack(req, stackIdFrom(req)),
  },
  "/api/stacks/:id/log": {
    GET: (req: Request) => handleGetStackLog(req, stackIdFrom(req)),
  },
  "/api/stacks/:id/member-logs": {
    GET: (req: Request) => handleGetStackMemberLogs(req, stackIdFrom(req)),
  },

  // --- Operation Engine ---
  "/api/operations": { GET: (req: Request) => handleListOperations(req) },
  "/api/operations/:id": { GET: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleGetOperation(req, id);
  }},
  "/api/operations/:id/events": { GET: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleOperationEvents(req, id);
  }},
  "/api/operations/:id/logs": { GET: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleGetOperationLogs(req, id);
  }},
  "/api/operations/:id/cancel": { POST: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleCancelOperation(req, id);
  }},
  "/api/operations/:id/retry": { POST: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleRetryOperation(req, id);
  }},
  "/api/operations/:id/finalize": { POST: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleFinalizeOperation(req, id);
  }},

  // --- Terminal ---
  "/api/terminal/exec": { POST: (req: Request) => handleTerminalExec(req) },

  // --- Volumes ---
};
