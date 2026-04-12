import { handleSetupStatus, handleSetupComplete, handleSetupServerTypes } from "./routes/setup.ts";
import { handleLogin, handleMe, handleUpdateMe, handlePasswordReset } from "./routes/auth.ts";
import {
  handleTotpSetup,
  handleTotpConfirm,
  handleTotpLogin,
  handleTotpSetupFromLogin,
  handleTotpConfirmFromLogin,
  handleTotpDisable,
  handleTotpStatus,
  handleTotpResetFromLogin,
} from "./routes/totp.ts";
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
  handleDeployJobPoll,
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
import { handleGetResources, handleDeleteResource } from "./routes/resources.ts";
import { handleAttachVolume, handleAttachExistingVolume, handleDetachVolume, handleReattachVolume, handleResizeVolume } from "./routes/volumes.ts";
import { handleScaleApp, handleUpdateScalingPolicy, handleGetReplicas, handleGetScalingEvents, handleGetAppMetrics, handleGetAppMetricsHistory, handleWakeApp, handleWakeStatus } from "./routes/scaling.ts";
import {
  handleEnableWebhook,
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
  handleGetCatalog,
  handleGetServices,
  handleGetService,
  handleDeployService,
  handleServiceDeployJobPoll,
  handleDestroyService,
  handleRestartService,
  handlePauseService,
  handleUnpauseService,
  handleGetServiceLogs,
  handleLinkService,
  handleUnlinkService,
} from "./routes/services.ts";

function appIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/apps\/(\d+)/);
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

function serviceLinkPartsFrom(req: Request): { serviceId: number; appId: number } {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/services\/(\d+)\/link\/(\d+)/);
  return match ? { serviceId: parseInt(match[1], 10), appId: parseInt(match[2], 10) } : { serviceId: 0, appId: 0 };
}

function environmentIdFrom(req: Request): number {
  const url = new URL(req.url);
  const match = url.pathname.match(/\/api\/environments\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}


export const apiRoutes = {
  // --- LLM-readable manifest docs (public) ---
  "/llm.txt": { GET: (req: Request) => handleLlmTxt(req) },

  // --- Setup ---
  "/api/setup/status": { GET: (req: Request) => handleSetupStatus(req) },
  "/api/setup/complete": { POST: (req: Request) => handleSetupComplete(req) },
  "/api/setup/server-types": { POST: (req: Request) => handleSetupServerTypes(req) },

  // --- Auth ---
  "/api/auth/login": { POST: (req: Request) => handleLogin(req) },
  "/api/auth/password-reset": { POST: (req: Request) => handlePasswordReset(req) },
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

  // --- TOTP ---
  "/api/auth/totp/setup": { POST: (req: Request) => handleTotpSetup(req) },
  "/api/auth/totp/confirm": { POST: (req: Request) => handleTotpConfirm(req) },
  "/api/auth/totp/login": { POST: (req: Request) => handleTotpLogin(req) },
  "/api/auth/totp/setup-from-login": { POST: (req: Request) => handleTotpSetupFromLogin(req) },
  "/api/auth/totp/confirm-from-login": { POST: (req: Request) => handleTotpConfirmFromLogin(req) },
  "/api/auth/totp/disable": { POST: (req: Request) => handleTotpDisable(req) },
  "/api/auth/totp/reset-from-login": { POST: (req: Request) => handleTotpResetFromLogin(req) },
  "/api/auth/totp/status": { GET: (req: Request) => handleTotpStatus(req) },

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
  "/api/deploy-jobs/:jobId": { GET: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[3], 10);
    return handleDeployJobPoll(req, id);
  }},

  // Scaling
  "/api/apps/:appId/scale": { POST: (req: Request) => handleScaleApp(req, appIdFrom(req)) },
  "/api/apps/:appId/scaling-policy": { PUT: (req: Request) => handleUpdateScalingPolicy(req, appIdFrom(req)) },
  "/api/apps/:appId/replicas": { GET: (req: Request) => handleGetReplicas(req, appIdFrom(req)) },
  "/api/apps/:appId/scaling-events": { GET: (req: Request) => handleGetScalingEvents(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics": { GET: (req: Request) => handleGetAppMetrics(req, appIdFrom(req)) },
  "/api/apps/:appId/metrics/history": { GET: (req: Request) => handleGetAppMetricsHistory(req, appIdFrom(req)) },

  // Webhooks
  "/api/apps/:appId/webhook/enable": { POST: (req: Request) => handleEnableWebhook(req, appIdFrom(req)) },
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
  "/api/services/deploy-jobs/:jobId": { GET: (req: Request) => {
    const id = parseInt(new URL(req.url).pathname.split("/")[4], 10);
    return handleServiceDeployJobPoll(req, id);
  }},
  "/api/services/:id": {
    GET: (req: Request) => handleGetService(req, serviceIdFrom(req)),
    DELETE: (req: Request) => handleDestroyService(req, serviceIdFrom(req)),
  },
  "/api/services/:id/restart": { POST: (req: Request) => handleRestartService(req, serviceIdFrom(req)) },
  "/api/services/:id/pause": { POST: (req: Request) => handlePauseService(req, serviceIdFrom(req)) },
  "/api/services/:id/unpause": { POST: (req: Request) => handleUnpauseService(req, serviceIdFrom(req)) },
  "/api/services/:id/logs": { GET: (req: Request) => handleGetServiceLogs(req, serviceIdFrom(req)) },
  "/api/services/:id/link/:appId": {
    POST: (req: Request) => {
      const { serviceId, appId } = serviceLinkPartsFrom(req);
      return handleLinkService(req, serviceId, appId);
    },
    DELETE: (req: Request) => {
      const { serviceId, appId } = serviceLinkPartsFrom(req);
      return handleUnlinkService(req, serviceId, appId);
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

  // --- Volumes ---
  "/api/volumes/attach": { POST: (req: Request) => handleAttachVolume(req) },
  "/api/volumes/attach-existing": { POST: (req: Request) => handleAttachExistingVolume(req) },
  "/api/volumes/detach": { POST: (req: Request) => handleDetachVolume(req) },
  "/api/volumes/reattach": { POST: (req: Request) => handleReattachVolume(req) },
  "/api/volumes/resize": { POST: (req: Request) => handleResizeVolume(req) },
};
