import { handleSetupStatus, handleSetupComplete, handleSetupServerTypes } from "./routes/setup.ts";
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
  handleDestroyApp,
  handleRestartApp,
  handlePauseApp,
  handleUnpauseApp,
  handleRedeployApp,
  handleRenameApp,
  handleGetContainerLogs,
  handleGetDeployLog,
  handleGetDeployments,
  handleRollbackApp,
  handleIntrospectRepo,
} from "./routes/apps.ts";
import { handleDeleteServer, handleRefreshServers } from "./routes/servers.ts";
import { handleGetSettings, handleSaveSettings, handleGetServerTypes } from "./routes/settings.ts";
import { handleGetResources, handleGetServerMetricsHistory, handleDeleteResource, handleCreateServer, handleGetVolumeDetail, handleListVolumeFiles, handleGetVolumeFile } from "./routes/resources.ts";
import { handleAttachVolume, handleAttachExistingVolume, handleDetachVolume, handleReattachVolume, handleResizeVolume } from "./routes/volumes.ts";
import { handleScaleApp, handleUpdateScalingPolicy, handleGetReplicas, handleGetScalingEvents, handleGetAppMetrics, handleGetAppMetricsHistory, handleWakeApp, handleWakeStatus, handleMigrateReplica } from "./routes/scaling.ts";
import {
  handleEnableWebhook,
  handleUpdateWebhookSettings,
  handleDisableWebhook,
  handleGithubWebhook,
  handlePanelGithubWebhook,
  handleEnablePanelWebhook,
  handleDisablePanelWebhook,
} from "./routes/webhooks.ts";
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
import { handleLlmTxt } from "./routes/llm-txt.ts";
import { handleDeviceCode, handleDeviceToken, handleDeviceConfirm } from "./routes/device-auth.ts";
import { handleCliInstallSh, handleCliDownload } from "./routes/cli.ts";
import { handleGetDeploySession, handleSaveDeploySession, handleDeleteDeploySession } from "./routes/deploy-sessions.ts";
import {
  handleGetEnvironments,
  handleCreateEnvironment,
  handleUpdateEnvironment,
  handleDeleteEnvironment,
  handleGetEnvironmentApps,
  handleAttachAppToEnvironment,
  handleDetachAppFromEnvironment,
} from "./routes/environments.ts";
import {
  handleListOperations,
  handleGetOperation,
  handleOperationEvents,
  handleGetOperationLogs,
  handleCancelOperation,
} from "./routes/operations.ts";
import { handleTerminalExec } from "./routes/terminal-exec.ts";
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


export const apiRoutes = {
  // --- Health probe (public, used by Docker HEALTHCHECK and reverse proxies) ---
  "/api/health": {
    GET: () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },

  // --- LLM-readable manifest docs (public) ---
  "/llm.txt": { GET: (req: Request) => handleLlmTxt(req) },

  // --- CLI distribution (public) ---
  "/cli/install.sh": { GET: (req: Request) => handleCliInstallSh(req) },
  "/cli/:binary": { GET: (req: Request) => handleCliDownload(req) },

  // --- Setup ---
  "/api/setup/status": { GET: (req: Request) => handleSetupStatus(req) },
  "/api/setup/complete": { POST: (req: Request) => handleSetupComplete(req) },
  "/api/setup/server-types": { POST: (req: Request) => handleSetupServerTypes(req) },

  // --- Auth ---
  "/api/auth/login": { POST: (req: Request) => handleLogin(req) },
  "/api/auth/device-code": { POST: () => handleDeviceCode() },
  "/api/auth/device-token": { POST: (req: Request) => handleDeviceToken(req) },
  "/api/auth/device-confirm": { POST: (req: Request) => handleDeviceConfirm(req) },
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
  "/api/servers/:id": { DELETE: (req: Request) => handleDeleteServer(req, serverIdFrom(req)) },

  // --- Apps ---
  "/api/apps": { GET: (req: Request) => handleGetApps(req) },
  "/api/apps/deploy": { POST: (req: Request) => handleDeploy(req) },
  "/api/repos/introspect": { GET: (req: Request) => handleIntrospectRepo(req) },
  "/api/deploy-session": {
    GET: (req: Request) => handleGetDeploySession(req),
    POST: (req: Request) => handleSaveDeploySession(req),
    DELETE: (req: Request) => handleDeleteDeploySession(req),
  },

  // App-specific
  "/api/apps/:appId": { DELETE: (req: Request) => handleDestroyApp(req, appIdFrom(req)) },
  "/api/apps/:appId/restart": { POST: (req: Request) => handleRestartApp(req, appIdFrom(req)) },
  "/api/apps/:appId/pause": { POST: (req: Request) => handlePauseApp(req, appIdFrom(req)) },
  "/api/apps/:appId/unpause": { POST: (req: Request) => handleUnpauseApp(req, appIdFrom(req)) },
  "/api/apps/:appId/redeploy": { POST: (req: Request) => handleRedeployApp(req, appIdFrom(req)) },
  "/api/apps/:appId/rename": { PUT: (req: Request) => handleRenameApp(req, appIdFrom(req)) },
  "/api/apps/:appId/logs": { GET: (req: Request) => handleGetContainerLogs(req, appIdFrom(req)) },
  "/api/apps/:appId/deploy-log": { GET: (req: Request) => handleGetDeployLog(req, appIdFrom(req)) },
  "/api/apps/:appId/deployments": { GET: (req: Request) => handleGetDeployments(req, appIdFrom(req)) },
  "/api/apps/:appId/rollback": { POST: (req: Request) => handleRollbackApp(req, appIdFrom(req)) },

  // Scaling
  "/api/apps/:appId/scale": { POST: (req: Request) => handleScaleApp(req, appIdFrom(req)) },
  "/api/apps/:appId/scaling-policy": { PUT: (req: Request) => handleUpdateScalingPolicy(req, appIdFrom(req)) },
  "/api/apps/:appId/replicas": { GET: (req: Request) => handleGetReplicas(req, appIdFrom(req)) },
  "/api/apps/:appId/replicas/:replicaId/migrate": { POST: (req: Request) => handleMigrateReplica(req, appIdFrom(req), replicaIdFrom(req)) },
  "/api/apps/:appId/scaling-events": { GET: (req: Request) => handleGetScalingEvents(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics": { GET: (req: Request) => handleGetAppMetrics(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics/history": { GET: (req: Request) => handleGetAppMetricsHistory(req, appIdFrom(req)) },

  // Webhooks
  "/api/apps/:appId/webhook/enable": { POST: (req: Request) => handleEnableWebhook(req, appIdFrom(req)) },
  "/api/apps/:appId/webhook/settings": { POST: (req: Request) => handleUpdateWebhookSettings(req, appIdFrom(req)) },
  "/api/apps/:appId/webhook/disable": { POST: (req: Request) => handleDisableWebhook(req, appIdFrom(req)) },

  // Public GitHub webhook receiver for the panel itself (HMAC verified)
  "/webhooks/github/panel": {
    POST: (req: Request) => handlePanelGithubWebhook(req),
  },

  // Public GitHub webhook receiver (no auth — HMAC verified per app)
  "/webhooks/github/:appId": {
    POST: (req: Request) => {
      const m = new URL(req.url).pathname.match(/\/webhooks\/github\/(\d+)/);
      return handleGithubWebhook(req, m ? parseInt(m[1], 10) : 0);
    },
  },

  // Public wake endpoints (no auth — called from the wake page on the app's domain)
  "/api/apps/:appId/wake": {
    POST: (req: Request) => handleWakeApp(req, appIdFrom(req)),
    OPTIONS: () => new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }),
  },
  "/api/apps/:appId/wake-status": {
    GET: (req: Request) => handleWakeStatus(req, appIdFrom(req)),
    OPTIONS: () => new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }),
  },

  // --- Admin: Settings ---
  "/api/admin/settings": {
    GET: (req: Request) => handleGetSettings(req),
    PUT: (req: Request) => handleSaveSettings(req),
  },
  "/api/admin/settings/server-types": { GET: (req: Request) => handleGetServerTypes(req) },

  // --- Admin: Panel (hosted self) ---
  "/api/admin/panel": { GET: (req: Request) => handleGetPanel(req) },
  "/api/admin/panel/redeploy": { POST: (req: Request) => handleRedeployPanel(req) },
  "/api/admin/panel/webhook/enable": { POST: (req: Request) => handleEnablePanelWebhook(req) },
  "/api/admin/panel/webhook/disable": { POST: (req: Request) => handleDisablePanelWebhook(req) },
  "/api/admin/panel/logs": { GET: (req: Request) => handleGetPanelLogs(req) },
  "/api/admin/panel/deployments": { GET: (req: Request) => handleGetPanelDeployments(req) },

  // --- Resources ---
  "/api/resources": { GET: (req: Request) => handleGetResources(req) },
  "/api/resources/servers": { POST: (req: Request) => handleCreateServer(req) },
  "/api/resources/metrics/history": { GET: (req: Request) => handleGetServerMetricsHistory(req) },
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
  "/api/environments/:id": {
    PUT: (req: Request) => handleUpdateEnvironment(req, environmentIdFrom(req)),
    DELETE: (req: Request) => handleDeleteEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/apps": {
    GET: (req: Request) => handleGetEnvironmentApps(req, environmentIdFrom(req)),
    POST: (req: Request) => handleAttachAppToEnvironment(req, environmentIdFrom(req)),
  },
  "/api/environments/:id/apps/detach": {
    POST: (req: Request) => handleDetachAppFromEnvironment(req, environmentIdFrom(req)),
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

  // --- Terminal ---
  "/api/terminal/exec": { POST: (req: Request) => handleTerminalExec(req) },

  // --- Volumes ---
  "/api/volumes/attach": { POST: (req: Request) => handleAttachVolume(req) },
  "/api/volumes/attach-existing": { POST: (req: Request) => handleAttachExistingVolume(req) },
  "/api/volumes/detach": { POST: (req: Request) => handleDetachVolume(req) },
  "/api/volumes/reattach": { POST: (req: Request) => handleReattachVolume(req) },
  "/api/volumes/resize": { POST: (req: Request) => handleResizeVolume(req) },
};
