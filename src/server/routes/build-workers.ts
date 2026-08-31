import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";
import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { normalizeBuildWorkerName, probeBuildWorker } from "../../engine/build-worker.ts";

function publicWorker(worker: db.BuildWorkerRow) {
  const server = db.getServer(worker.server_id);
  return {
    ...worker,
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

export async function handleGetBuildWorkers(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const rows = await Promise.all(db.getBuildWorkers().map(async (worker) => {
      const server = db.getServer(worker.server_id);
      if (!server) return publicWorker(worker);
      const observed = await probeBuildWorker(server);
      const status = worker.status === "installing"
        ? worker.status
        : observed.online ? "online" : worker.status === "conversion_required" ? worker.status : "error";
      db.updateBuildWorker(worker.id, {
        status,
        last_error: observed.online ? "" : observed.error,
        worker_version: observed.version || worker.worker_version,
        architecture: observed.architecture || worker.architecture,
        last_checked_at: new Date().toISOString(),
      });
      return { ...publicWorker(db.getBuildWorker(worker.id)!), disk_free_bytes: observed.diskFreeBytes };
    }));
    return Response.json(rows, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleInstallBuildWorker(request: Request): Promise<Response> {
  let secretKey = "";
  let insertedId = 0;
  try {
    const payload = await requirePermission(request, "servers.manage");
    const body = await request.json() as { server_id?: unknown; name?: unknown; removal_token?: unknown };
    const serverId = Number(body.server_id);
    const server = Number.isInteger(serverId) ? db.getServer(serverId) : null;
    if (!server) return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    if (server.status !== "ready") return Response.json({ error: `Server ${server.name} is not ready` }, { status: 409, headers: corsHeaders });
    if (db.getPanel()?.server_id === server.id || db.getApps(server.id).length) {
      return Response.json({ error: "Build workers require a dedicated server with no panel or apps" }, { status: 409, headers: corsHeaders });
    }
    const defaultName = `ocd-${server.name}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-+$/, "");
    const name = normalizeBuildWorkerName(String(body.name ?? defaultName));
    if (!name) return Response.json({ error: "name must be a lowercase worker slug" }, { status: 400, headers: corsHeaders });

    let worker = db.getBuildWorkerByServerId(server.id);
    if (worker) {
      if (!["conversion_required", "error"].includes(worker.status)) {
        return Response.json({ error: `Server already has build worker ${worker.name} (${worker.status})` }, { status: 409, headers: corsHeaders });
      }
      if (worker.status === "conversion_required") {
        const token = String(body.removal_token ?? "").trim();
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
          return Response.json({ error: "A fresh GitHub runner removal token is required once to deregister the old Actions runner" }, { status: 400, headers: corsHeaders });
        }
        secretKey = `build_worker_conversion:${crypto.randomUUID()}`;
        await secretStore.set(secretKey, token);
      }
      db.updateBuildWorker(worker.id, { status: "installing", last_error: "" });
    } else {
      if (db.getBuildWorkers().some((candidate) => candidate.name === name)) {
        return Response.json({ error: `Build worker name ${name} is already in use` }, { status: 409, headers: corsHeaders });
      }
      const previousPool = server.pool || "general";
      worker = db.insertBuildWorker({ serverId: server.id, name, previousPool });
      insertedId = worker.id;
    }
    db.clearServerGcRequest(server.id);
    db.updateServerPool(server.id, "build-workers");
    const { opId } = enqueue({
      kind: "install_build_worker",
      resourceKeys: [`builder:${worker.id}`, `server:${server.id}`],
      input: { workerId: worker.id, removalTokenSecretKey: secretKey || undefined },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId, worker: publicWorker(worker) }, { status: 202, headers: corsHeaders });
  } catch (error) {
    if (secretKey) await secretStore.delete(secretKey).catch(() => {});
    if (insertedId) db.deleteBuildWorker(insertedId);
    return handleError(error);
  }
}

export async function handleRemoveBuildWorker(request: Request, workerId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "servers.manage");
    const worker = db.getBuildWorker(workerId);
    if (!worker) return Response.json({ error: "Build worker not found" }, { status: 404, headers: corsHeaders });
    const { opId } = enqueue({
      kind: "remove_build_worker",
      resourceKeys: [`builder:${worker.id}`, `server:${worker.server_id}`],
      input: { workerId: worker.id },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { status: 202, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetBuildSources(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const panel = db.getPanel();
    const base = panel?.domain ? `https://${panel.domain}` : new URL(request.url).origin;
    const rows = await Promise.all(db.getBuildSources().map(async (source) => ({
      ...source,
      webhook_url: `${base}/webhooks/github/build/${source.id}`,
      webhook_secret_configured: !!(await secretStore.get(`build_source_webhook:${source.id}`)),
    })));
    return Response.json(rows, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRotateBuildSourceWebhook(request: Request, sourceId: number): Promise<Response> {
  try {
    await requirePermission(request, "servers.manage");
    const source = db.getBuildSource(sourceId);
    if (!source) return Response.json({ error: "Build source not found" }, { status: 404, headers: corsHeaders });
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await secretStore.set(`build_source_webhook:${source.id}`, secret);
    const panel = db.getPanel();
    const base = panel?.domain ? `https://${panel.domain}` : new URL(request.url).origin;
    return Response.json({ webhook_url: `${base}/webhooks/github/build/${source.id}`, secret }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
