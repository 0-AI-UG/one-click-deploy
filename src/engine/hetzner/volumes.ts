import { hetznerApi } from "./api.ts";
import { pollAction } from "./actions.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

type HetznerAction = { id: number; status: string; command: string; started: string };
type HetznerVolume = { id: number; linux_device: string; server: number | null };
type WithAction = { action?: HetznerAction };
type WithVolume = { volume: HetznerVolume };
type WithActions = { actions?: HetznerAction[] };

export async function createVolume(opts: {
  name: string;
  size: number; // GB
  server_id: number;
  location: string;
}): Promise<{ id: number; linux_device: string }> {
  log("volume", `Creating ${opts.size}GB volume "${opts.name}" for server ${opts.server_id}`);
  const data = await hetznerApi("/volumes", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      size: opts.size,
      server: opts.server_id,
      format: "ext4",
      automount: true,
      labels: { managed_by: "one-click-deploy" },
    }),
  }) as unknown as WithAction & WithVolume;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("volume", `Volume created: id=${data.volume.id} device=${data.volume.linux_device}`);
  return { id: data.volume.id, linux_device: data.volume.linux_device };
}

export async function detachVolume(volumeId: string) {
  log("volume", `Detaching volume ${volumeId}`);

  // Check if volume is actually attached before trying to detach
  const volumeData = await hetznerApi(`/volumes/${volumeId}`) as unknown as WithVolume;
  if (!volumeData.volume?.server) {
    log("volume", `Volume ${volumeId} is not attached to any server, skipping detach`);
    return;
  }

  const data = await hetznerApi(`/volumes/${volumeId}/actions/detach`, { method: "POST", body: "{}" }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("volume", `Volume ${volumeId} detached`);
}

export async function attachVolume(volumeId: string, serverId: number) {
  log("volume", `Attaching volume ${volumeId} to server ${serverId}`);

  // Check for stuck running actions on this volume
  const actionsData = await hetznerApi(`/volumes/${volumeId}/actions?sort=id:desc&per_page=5`) as unknown as WithActions;
  const running = actionsData.actions?.filter((a) => a.status === "running");
  if (running && running.length > 0) {
    log("volume", `Found ${running.length} running action(s) on volume ${volumeId}, waiting for them to finish`);
    for (const a of running) {
      log("volume", `Waiting for action ${a.id} (${a.command}) started=${a.started}`);
      await pollAction(a.id, { timeoutMs: 30000 });
    }
  }

  const data = await hetznerApi(`/volumes/${volumeId}/actions/attach`, {
    method: "POST",
    body: JSON.stringify({ server: serverId, automount: true }),
  }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("volume", `Volume ${volumeId} attached to server ${serverId}`);
}

export async function resizeVolume(volumeId: string, size: number) {
  log("volume", `Resizing volume ${volumeId} to ${size}GB`);
  const data = await hetznerApi(`/volumes/${volumeId}/actions/resize`, {
    method: "POST",
    body: JSON.stringify({ size }),
  }) as unknown as WithAction;
  if (data.action?.id) {
    await pollAction(data.action.id);
  }
  log("volume", `Volume ${volumeId} resized to ${size}GB`);
}

export async function renameVolume(volumeId: string, name: string) {
  log("volume", `Renaming volume ${volumeId} to "${name}"`);
  await hetznerApi(`/volumes/${volumeId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
  log("volume", `Volume ${volumeId} renamed to "${name}"`);
}

export async function deleteVolume(volumeId: string) {
  // Try to detach first (required by Hetzner before delete)
  const volumeData = await hetznerApi(`/volumes/${volumeId}`) as unknown as WithVolume;
  if (volumeData.volume?.server) {
    log("volume", `Volume ${volumeId} is attached to server ${volumeData.volume.server}, detaching first`);
    try {
      const data = await hetznerApi(`/volumes/${volumeId}/actions/detach`, { method: "POST", body: "{}" }) as unknown as WithAction;
      if (data.action?.id) {
        await pollAction(data.action.id, { timeoutMs: 30000 });
      }
    } catch (err) {
      log("volume", `Detach before delete failed (will retry delete): ${err}`);
    }
  }
  await hetznerApi(`/volumes/${volumeId}`, { method: "DELETE" });
  log("volume", `Volume ${volumeId} deleted`);
}
