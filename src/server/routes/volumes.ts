import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";
import * as db from "../../shared/db.ts";

// Volume management is a multi-step infra saga (Hetzner volume create/attach +
// SSH bind-mount + container recreate + app-state writes). These handlers are
// thin: they do a cheap permission + read-only precondition check for good UX
// (fast 400s with a clear message), then enqueue the corresponding engine op
// and return its op_id. The op re-validates authoritatively under the app lock
// (guarding TOCTOU) and carries the compensation + crash-resume logic.

function badRequest(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400, headers: corsHeaders });
}

export async function handleAttachVolume(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "volumes.create");
    const { app_id, size, mount_path } = await request.json() as { app_id: number; size: number; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return badRequest("App not found");
    if (app.volume_id) return badRequest("App already has a volume attached");
    const reps = db.getReplicas(app_id);
    if (reps.length === 0) return badRequest("App has no replicas");
    if (reps.length > 1) return badRequest("Cannot attach a volume to an app with more than 1 replica. Scale down to 1 first.");
    if (!db.getServer(reps[0].server_id)) return badRequest("Server not found");

    const { opId } = enqueue({
      kind: "attach_volume",
      resourceKeys: [`app:${app_id}`],
      input: { appId: app_id, sizeGb: size, mountPath: mount_path },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAttachExistingVolume(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "volumes.manage");
    const { app_id, volume_id, mount_path } = await request.json() as { app_id: number; volume_id: string; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return badRequest("App not found");
    if (app.volume_id) return badRequest("App already has a volume attached");
    const reps = db.getReplicas(app_id);
    if (reps.length === 0) return badRequest("App has no replicas");
    if (reps.length > 1) return badRequest("Cannot attach a volume to an app with more than 1 replica. Scale down to 1 first.");
    if (!db.getServer(reps[0].server_id)) return badRequest("Server not found");

    const { opId } = enqueue({
      kind: "attach_existing_volume",
      resourceKeys: [`app:${app_id}`],
      input: { appId: app_id, volumeId: volume_id, mountPath: mount_path },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDetachVolume(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "volumes.manage");
    const { app_id } = await request.json() as { app_id: number };

    const app = db.getApp(app_id);
    if (!app) return badRequest("App not found");
    if (!app.volume_id) return badRequest("App has no volume attached");

    const { opId } = enqueue({
      kind: "detach_volume",
      resourceKeys: [`app:${app_id}`],
      input: { appId: app_id },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleReattachVolume(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "volumes.manage");
    const { volume_id, from_app_id, to_app_id, mount_path } = await request.json() as {
      volume_id: string; from_app_id: number; to_app_id: number; mount_path?: string;
    };

    const fromApp = db.getApp(from_app_id);
    if (!fromApp) return badRequest("Source app not found");
    const toApp = db.getApp(to_app_id);
    if (!toApp) return badRequest("Target app not found");
    if (toApp.volume_id) return badRequest("Target app already has a volume");

    const { opId } = enqueue({
      kind: "reattach_volume",
      resourceKeys: [`app:${from_app_id}`, `app:${to_app_id}`],
      input: { volumeId: volume_id, fromAppId: from_app_id, toAppId: to_app_id, mountPath: mount_path },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleResizeVolume(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "volumes.manage");
    const { volume_id, size } = await request.json() as { volume_id: string; size: number };

    const { opId } = enqueue({
      kind: "resize_volume",
      resourceKeys: [`volume:${volume_id}`],
      input: { volumeId: volume_id, sizeGb: size },
      trigger: "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
