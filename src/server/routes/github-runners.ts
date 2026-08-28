import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  GITHUB_RUNNER_LABEL,
  getGitHubRunnerLogs,
  normalizeGitHubRunnerName,
  normalizeGitHubRunnerScope,
  probeGitHubRunner,
  validGitHubRunnerToken,
} from "../../engine/github-runner.ts";

type InstallBody = {
  server_id?: unknown;
  scope_url?: unknown;
  registration_token?: unknown;
  name?: unknown;
};

function publicRunner(runner: db.GitHubRunnerRow) {
  const server = db.getServer(runner.server_id);
  return {
    ...runner,
    server: server ? {
      id: server.id,
      name: server.name,
      ipv4: server.ipv4,
      status: server.status,
      pool: server.pool,
      provider: server.provider,
      ownership: server.ownership,
    } : null,
  };
}

export async function handleGetGitHubRunners(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const rows = await Promise.all(db.getGitHubRunners().map(async (runner) => {
      const server = db.getServer(runner.server_id);
      if (!server) return publicRunner(runner);
      const observed = await probeGitHubRunner(server);
      const status = ["installing", "removing"].includes(runner.status)
        ? runner.status
        : observed.online ? "online" : observed.error ? "error" : observed.configured ? "offline" : runner.status;
      db.updateGitHubRunner(runner.id, {
        status,
        last_error: observed.error,
        runner_version: observed.version || runner.runner_version,
        architecture: observed.architecture || runner.architecture,
        last_checked_at: new Date().toISOString(),
      });
      return {
        ...publicRunner(db.getGitHubRunner(runner.id)!),
        disk_free_bytes: observed.diskFreeBytes,
      };
    }));
    return Response.json(rows, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInstallGitHubRunner(request: Request): Promise<Response> {
  let secretKey = "";
  let insertedRunnerId = 0;
  let previousPool = "";
  let previousRunnerStatus = "";
  let serverId = 0;
  try {
    const payload = await requirePermission(request, "servers.manage");
    const body = await request.json() as InstallBody;
    serverId = Number(body.server_id);
    const server = Number.isInteger(serverId) ? db.getServer(serverId) : null;
    if (!server) return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    if (server.status !== "ready") {
      return Response.json({ error: `Server ${server.name} is not ready` }, { status: 409, headers: corsHeaders });
    }
    if (db.getPanel()?.server_id === server.id || db.getApps(server.id).length > 0 || db.getServicesOnServer(server.id).length > 0) {
      return Response.json(
        { error: "Build runners require a dedicated server with no panel, apps, or managed services" },
        { status: 409, headers: corsHeaders },
      );
    }
    const scopeUrl = normalizeGitHubRunnerScope(String(body.scope_url ?? ""));
    const registrationToken = String(body.registration_token ?? "").trim();
    const defaultName = `ocd-${server.name}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "");
    const name = normalizeGitHubRunnerName(String(body.name ?? defaultName));
    if (!scopeUrl) {
      return Response.json({ error: "scope_url must be https://github.com/OWNER or https://github.com/OWNER/REPO" }, { status: 400, headers: corsHeaders });
    }
    if (!name) return Response.json({ error: "name must be a lowercase runner slug" }, { status: 400, headers: corsHeaders });
    if (!validGitHubRunnerToken(registrationToken)) {
      return Response.json({ error: "registration_token is invalid; copy a fresh one-hour token from GitHub Actions runner settings" }, { status: 400, headers: corsHeaders });
    }

    const existing = db.getGitHubRunnerByServerId(server.id);
    let runner: db.GitHubRunnerRow;
    if (existing) {
      if (existing.status !== "error" && existing.status !== "offline") {
        return Response.json({ error: `Server already has runner ${existing.name} (${existing.status})` }, { status: 409, headers: corsHeaders });
      }
      if (existing.name !== name || existing.scope_url !== scopeUrl) {
        return Response.json({ error: "Remove the existing failed runner before changing its name or GitHub scope" }, { status: 409, headers: corsHeaders });
      }
      runner = existing;
      previousRunnerStatus = runner.status;
      db.updateGitHubRunner(runner.id, { status: "installing", last_error: "" });
    } else {
      if (db.getGitHubRunners().some((candidate) => candidate.name === name)) {
        return Response.json({ error: `Runner name ${name} is already in use` }, { status: 409, headers: corsHeaders });
      }
      previousPool = server.pool || "general";
      runner = db.insertGitHubRunner({ serverId: server.id, name, scopeUrl, previousPool });
      insertedRunnerId = runner.id;
    }

    db.clearServerGcRequest(server.id);
    db.updateServerPool(server.id, "build-runners");
    secretKey = `github_runner_registration:${crypto.randomUUID()}`;
    await secretStore.set(secretKey, registrationToken);
    const { opId } = enqueue({
      kind: "install_github_runner",
      resourceKeys: [`runner:${runner.id}`, `server:${server.id}`],
      input: { runnerId: runner.id, tokenSecretKey: secretKey },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId, runner: publicRunner(runner), workflow_runs_on: ["self-hosted", GITHUB_RUNNER_LABEL] }, { status: 202, headers: corsHeaders });
  } catch (error) {
    if (secretKey) await secretStore.delete(secretKey).catch(() => {});
    if (insertedRunnerId) {
      try { db.deleteGitHubRunner(insertedRunnerId); } catch { /* best effort */ }
      try { db.updateServerPool(serverId, previousPool || "general"); } catch { /* best effort */ }
    } else if (previousRunnerStatus) {
      const runner = db.getGitHubRunnerByServerId(serverId);
      if (runner) db.updateGitHubRunner(runner.id, { status: previousRunnerStatus });
    }
    return handleError(error);
  }
}

export async function handleRemoveGitHubRunner(request: Request, runnerId: number): Promise<Response> {
  let secretKey = "";
  let previousStatus = "";
  try {
    const payload = await requirePermission(request, "servers.manage");
    const runner = db.getGitHubRunner(runnerId);
    if (!runner) return Response.json({ error: "GitHub runner not found" }, { status: 404, headers: corsHeaders });
    if (runner.status === "removing") {
      return Response.json({ error: "GitHub runner removal is already in progress" }, { status: 409, headers: corsHeaders });
    }
    const body = await request.json().catch(() => ({})) as { removal_token?: unknown };
    const removalToken = String(body.removal_token ?? "").trim();
    if (!validGitHubRunnerToken(removalToken)) {
      return Response.json({ error: "A fresh GitHub runner removal token is required" }, { status: 400, headers: corsHeaders });
    }
    secretKey = `github_runner_removal:${crypto.randomUUID()}`;
    await secretStore.set(secretKey, removalToken);
    previousStatus = runner.status;
    db.updateGitHubRunner(runner.id, { status: "removing", last_error: "" });
    const { opId } = enqueue({
      kind: "remove_github_runner",
      resourceKeys: [`runner:${runner.id}`, `server:${runner.server_id}`],
      input: { runnerId: runner.id, tokenSecretKey: secretKey },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { status: 202, headers: corsHeaders });
  } catch (error) {
    if (secretKey) await secretStore.delete(secretKey).catch(() => {});
    if (previousStatus && db.getGitHubRunner(runnerId)) {
      db.updateGitHubRunner(runnerId, { status: previousStatus });
    }
    return handleError(error);
  }
}

export async function handleGetGitHubRunnerLogs(request: Request, runnerId: number): Promise<Response> {
  try {
    await requirePermission(request, "terminal.host");
    const runner = db.getGitHubRunner(runnerId);
    const server = runner ? db.getServer(runner.server_id) : null;
    if (!runner || !server) return Response.json({ error: "GitHub runner not found" }, { status: 404, headers: corsHeaders });
    const tail = Math.min(1000, Math.max(1, Number(new URL(request.url).searchParams.get("tail") || 200)));
    return Response.json({ logs: await getGitHubRunnerLogs(server, tail) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
