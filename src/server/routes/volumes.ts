import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../bun/db.ts";
import * as hetzner from "../../bun/hetzner/index.ts";
import { recreateAppContainer } from "../../bun/deploy/index.ts";

export async function handleAttachVolume(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "volumes.create");
    const { app_id, size, mount_path } = await request.json() as { app_id: number; size: number; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (app.volume_id) return Response.json({ ok: false, error: "App already has a volume attached" }, { headers: corsHeaders });
    const server = db.getServer(app.server_id);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    const hostKey = server.ssh_host_key || undefined;

    const suffix = Date.now().toString(36).slice(-4);
    const volName = `ocd-${app.name}-${suffix}`;
    const vol = await hetzner.createVolume({
      name: volName,
      size,
      server_id: parseInt(server.hetzner_id, 10),
      location: server.location,
    });

    const hostMountPath = `/mnt/${volName}`;
    const containerPath = mount_path || "/data";
    await hetzner.sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;

    db.updateAppVolume(app_id, String(vol.id), volumeMount);
    const result = await recreateAppContainer(app_id, volumeMount);
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleAttachExistingVolume(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "volumes.manage");
    const { app_id, volume_id, mount_path } = await request.json() as { app_id: number; volume_id: string; mount_path?: string };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (app.volume_id) return Response.json({ ok: false, error: "App already has a volume attached" }, { headers: corsHeaders });
    const server = db.getServer(app.server_id);
    if (!server) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    const hostKey = server.ssh_host_key || undefined;

    const volInfo = await hetzner.hetznerApi(`/volumes/${volume_id}`);
    const volLocation = volInfo.volume?.location?.name;
    if (volLocation && volLocation !== server.location) {
      return Response.json({ ok: false, error: `Cannot attach: volume is in ${volLocation} but server is in ${server.location}` }, { headers: corsHeaders });
    }

    await hetzner.attachVolume(volume_id, parseInt(server.hetzner_id, 10));
    const hostMountPath = `/mnt/vol-${volume_id}`;
    const containerPath = mount_path || "/data";
    await hetzner.sshExec(server.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, hostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;

    db.updateAppVolume(app_id, volume_id, volumeMount);
    const result = await recreateAppContainer(app_id, volumeMount);
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDetachVolume(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "volumes.manage");
    const { app_id } = await request.json() as { app_id: number };

    const app = db.getApp(app_id);
    if (!app) return Response.json({ ok: false, error: "App not found" }, { headers: corsHeaders });
    if (!app.volume_id) return Response.json({ ok: false, error: "App has no volume attached" }, { headers: corsHeaders });

    await hetzner.detachVolume(app.volume_id);
    db.updateAppVolume(app_id, "", "");
    const result = await recreateAppContainer(app_id, undefined);
    if (!result.ok) return Response.json({ ok: false, error: result.error || "Failed to recreate container" }, { headers: corsHeaders });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleReattachVolume(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "volumes.manage");
    const { volume_id, from_app_id, to_app_id, mount_path } = await request.json() as {
      volume_id: string; from_app_id: number; to_app_id: number; mount_path?: string;
    };

    const fromApp = db.getApp(from_app_id);
    if (!fromApp) return Response.json({ ok: false, error: "Source app not found" }, { headers: corsHeaders });
    const toApp = db.getApp(to_app_id);
    if (!toApp) return Response.json({ ok: false, error: "Target app not found" }, { headers: corsHeaders });
    if (toApp.volume_id) return Response.json({ ok: false, error: "Target app already has a volume" }, { headers: corsHeaders });

    const fromServer = db.getServer(fromApp.server_id);
    const toServer = db.getServer(toApp.server_id);
    if (!fromServer || !toServer) return Response.json({ ok: false, error: "Server not found" }, { headers: corsHeaders });
    if (fromServer.location !== toServer.location) {
      return Response.json({ ok: false, error: `Cannot reattach: volume in ${fromServer.location}, target in ${toServer.location}` }, { headers: corsHeaders });
    }

    await hetzner.detachVolume(volume_id);
    db.updateAppVolume(from_app_id, "", "");
    await recreateAppContainer(from_app_id, undefined);

    await hetzner.attachVolume(volume_id, parseInt(toServer.hetzner_id, 10));
    const hostMountPath = `/mnt/ocd-${toApp.name}-data`;
    const containerPath = mount_path || "/data";
    const toHostKey = toServer.ssh_host_key || undefined;
    await hetzner.sshExec(toServer.ipv4, `mkdir -p ${hostMountPath} && chown deploy:deploy ${hostMountPath}`, toHostKey);
    const volumeMount = `${hostMountPath}:${containerPath}`;
    db.updateAppVolume(to_app_id, volume_id, volumeMount);
    await recreateAppContainer(to_app_id, volumeMount);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleResizeVolume(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "volumes.manage");
    const { volume_id, size } = await request.json() as { volume_id: string; size: number };
    await hetzner.resizeVolume(volume_id, size);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
