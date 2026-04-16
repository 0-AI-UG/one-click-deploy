import { corsHeaders } from "../lib/cors.ts";
import { requireOrgPermission } from "../lib/org-context.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { getComputeProvider } from "../../shared/providers/index.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { recreateAppContainer } from "../../engine/deploy/index.ts";

function parseExtraVolumes(raw: string): string[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

export async function handleAttachVolume(request: Request): Promise<Response> {
  try {
    await requireOrgPermission(request, "volumes.create");
    const { app_id, size, mount_path } = await request.json() as { app_id: number; size: number; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (app.volume_id) return Response.json({ ok: false, error: "App already has a volume attached" }, { headers: corsHeaders });
    const reps = db.getReplicas(app_id);
    if (reps.length === 0) return Response.json({ ok: false, error: "App has no replicas" }, { headers: corsHeaders });
    if (reps.length > 1) return Response.json({ ok: false, error: "Cannot attach a volume to an app with more than 1 replica. Scale down to 1 first." }, { headers: corsHeaders });
    const server = db.getServer(reps[0].server_id);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    const hostKey = server.ssh_host_key || undefined;

    const compute = getComputeProvider();
    const suffix = Date.now().toString(36).slice(-4);
    const volName = `ocd-${app.name}-${suffix}`;
    const vol = await compute.volumes!.create({
      name: volName,
      sizeGb: size,
      serverId: server.provider_id,
      location: server.location,
    });

    const hostMountPath = `/mnt/${volName}`;
    const containerPath = mount_path || "/data";
    await sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;

    db.updateAppVolume(app_id, String(vol.providerId), volumeMount);
    // A volume locks the app to a single server: force min/max replicas to 1
    // so autoscale + manual scaling cannot ever bring up replica 2+.
    db.updateAppScaling(app_id, { min_replicas: Math.min(1, app.min_replicas), max_replicas: 1 });
    const result = await recreateAppContainer(app_id, volumeMount, parseExtraVolumes(app.extra_volumes));
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAttachExistingVolume(request: Request): Promise<Response> {
  try {
    await requireOrgPermission(request, "volumes.manage");
    const { app_id, volume_id, mount_path } = await request.json() as { app_id: number; volume_id: string; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (app.volume_id) return Response.json({ ok: false, error: "App already has a volume attached" }, { headers: corsHeaders });
    const reps = db.getReplicas(app_id);
    if (reps.length === 0) return Response.json({ ok: false, error: "App has no replicas" }, { headers: corsHeaders });
    if (reps.length > 1) return Response.json({ ok: false, error: "Cannot attach a volume to an app with more than 1 replica. Scale down to 1 first." }, { headers: corsHeaders });
    const server = db.getServer(reps[0].server_id);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    const hostKey = server.ssh_host_key || undefined;

    const compute = getComputeProvider();
    const volInfo = await compute.volumes!.get(volume_id);
    if (volInfo.location && volInfo.location !== server.location) {
      return Response.json({ ok: false, error: `Cannot attach: volume is in ${volInfo.location} but server is in ${server.location}` }, { headers: corsHeaders });
    }

    await compute.volumes!.attach(volume_id, server.provider_id);
    const hostMountPath = `/mnt/vol-${volume_id}`;
    const containerPath = mount_path || "/data";
    await sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;

    db.updateAppVolume(app_id, volume_id, volumeMount);
    // A volume locks the app to a single server: force min/max replicas to 1.
    db.updateAppScaling(app_id, { min_replicas: Math.min(1, app.min_replicas), max_replicas: 1 });
    const result = await recreateAppContainer(app_id, volumeMount, parseExtraVolumes(app.extra_volumes));
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDetachVolume(request: Request): Promise<Response> {
  try {
    await requireOrgPermission(request, "volumes.manage");
    const { app_id } = await request.json() as { app_id: number };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (!app.volume_id) return Response.json({ ok: false, error: "App has no volume attached" }, { headers: corsHeaders });

    const compute = getComputeProvider();
    await compute.volumes!.detach(app.volume_id);
    db.updateAppVolume(app_id, "", "");
    const result = await recreateAppContainer(app_id, undefined, parseExtraVolumes(app.extra_volumes));
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleReattachVolume(request: Request): Promise<Response> {
  try {
    await requireOrgPermission(request, "volumes.manage");
    const { volume_id, from_app_id, to_app_id, mount_path } = await request.json() as {
      volume_id: string; from_app_id: number; to_app_id: number; mount_path?: string;
    };

    const fromApp = db.getApp(from_app_id);
    if (!fromApp) return Response.json({ ok: false, error: "Source app not found" }, { headers: corsHeaders });
    const toApp = db.getApp(to_app_id);
    if (!toApp) return Response.json({ ok: false, error: "Target app not found" }, { headers: corsHeaders });
    if (toApp.volume_id) return Response.json({ ok: false, error: "Target app already has a volume" }, { headers: corsHeaders });

    const fromReps = db.getReplicas(from_app_id);
    const toReps = db.getReplicas(to_app_id);
    const fromServer = fromReps[0] ? db.getServer(fromReps[0].server_id) : null;
    const toServer = toReps[0] ? db.getServer(toReps[0].server_id) : null;
    if (!fromServer || !toServer) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    if (fromServer.location !== toServer.location) {
      return Response.json({ ok: false, error: `Cannot reattach: volume in ${fromServer.location}, target in ${toServer.location}` }, { headers: corsHeaders });
    }

    const compute = getComputeProvider();
    await compute.volumes!.detach(volume_id);
    db.updateAppVolume(from_app_id, "", "");
    await recreateAppContainer(from_app_id, undefined, parseExtraVolumes(fromApp.extra_volumes));

    await compute.volumes!.attach(volume_id, toServer.provider_id);
    const hostMountPath = `/mnt/ocd-${toApp.name}-data`;
    const containerPath = mount_path || "/data";
    const toHostKey = toServer.ssh_host_key || undefined;
    await sshExec(toServer.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, toHostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;
    db.updateAppVolume(to_app_id, volume_id, volumeMount);
    await recreateAppContainer(to_app_id, volumeMount, parseExtraVolumes(toApp.extra_volumes));

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleResizeVolume(request: Request): Promise<Response> {
  try {
    await requireOrgPermission(request, "volumes.manage");
    const { volume_id, size } = await request.json() as { volume_id: string; size: number };
    const compute = getComputeProvider();
    await compute.volumes!.resize(volume_id, size);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
