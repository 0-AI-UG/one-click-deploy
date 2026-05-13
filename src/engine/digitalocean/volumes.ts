import { doApi, pollDoAction } from "./api.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [do:${context}]`, ...args);
}

const MANAGED_TAG = "ocd-managed";

type DoVolume = {
  id: string;
  name: string;
  size_gigabytes: number;
  region: { slug: string };
  droplet_ids: number[];
  filesystem_type?: string;
  filesystem_label?: string;
};

type DoVolumeAction = { id: number; status: string };

/**
 * Create a volume, pre-formatted ext4 and attached to a droplet. Returns the
 * Linux device path. Like Hetzner, we don't rely on the kernel device name
 * (sda/sdb/...) — we expose the by-id path so cloud-init's mount snippet can
 * resolve it deterministically.
 */
export async function createDoVolume(opts: {
  name: string;
  size_gb: number;
  droplet_id: number;
  region: string;
}): Promise<{ id: string; linux_device: string }> {
  log("volume", `Creating ${opts.size_gb}GB volume "${opts.name}" for droplet ${opts.droplet_id}`);
  const data = await doApi("/volumes", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      size_gigabytes: opts.size_gb,
      region: opts.region,
      filesystem_type: "ext4",
      filesystem_label: opts.name.slice(0, 16),
      tags: [MANAGED_TAG],
    }),
  }) as { volume: DoVolume };
  const vol = data.volume;
  // Attach in a follow-up action (DO doesn't accept droplet_ids on create for new volumes).
  await attachDoVolume(vol.id, opts.droplet_id);
  // DO exposes block devices as /dev/disk/by-id/scsi-0DO_Volume_<label>.
  const label = (vol.filesystem_label || opts.name).replace(/[^A-Za-z0-9_-]/g, "_");
  const linux_device = `/dev/disk/by-id/scsi-0DO_Volume_${label}`;
  log("volume", `Volume created: id=${vol.id} device=${linux_device}`);
  return { id: vol.id, linux_device };
}

export async function getDoVolume(volumeId: string): Promise<DoVolume> {
  const data = await doApi(`/volumes/${volumeId}`) as { volume: DoVolume };
  return data.volume;
}

export async function listDoVolumes(): Promise<DoVolume[]> {
  const data = await doApi(`/volumes?per_page=200`) as { volumes: DoVolume[] };
  return (data.volumes ?? []).filter((v) => (v as DoVolume & { tags?: string[] }).tags?.includes?.(MANAGED_TAG) ?? false);
}

export async function attachDoVolume(volumeId: string, dropletId: number): Promise<void> {
  log("volume", `Attaching volume ${volumeId} to droplet ${dropletId}`);
  const data = await doApi(`/volumes/${volumeId}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "attach", droplet_id: dropletId }),
  }) as { action: DoVolumeAction };
  if (data.action?.id) await pollDoAction(data.action.id);
  log("volume", `Volume ${volumeId} attached to droplet ${dropletId}`);
}

export async function detachDoVolume(volumeId: string): Promise<void> {
  log("volume", `Detaching volume ${volumeId}`);
  const vol = await getDoVolume(volumeId);
  const dropletId = vol.droplet_ids?.[0];
  if (!dropletId) {
    log("volume", `Volume ${volumeId} not attached, skipping detach`);
    return;
  }
  const data = await doApi(`/volumes/${volumeId}/actions`, {
    method: "POST",
    body: JSON.stringify({ type: "detach", droplet_id: dropletId }),
  }) as { action: DoVolumeAction };
  if (data.action?.id) await pollDoAction(data.action.id);
  log("volume", `Volume ${volumeId} detached`);
}

export async function resizeDoVolume(volumeId: string, size_gb: number): Promise<void> {
  log("volume", `Resizing volume ${volumeId} to ${size_gb}GB`);
  const vol = await getDoVolume(volumeId);
  const data = await doApi(`/volumes/${volumeId}/actions`, {
    method: "POST",
    body: JSON.stringify({
      type: "resize",
      size_gigabytes: size_gb,
      region: vol.region.slug,
    }),
  }) as { action: DoVolumeAction };
  if (data.action?.id) await pollDoAction(data.action.id);
  log("volume", `Volume ${volumeId} resized to ${size_gb}GB`);
}

export async function deleteDoVolume(volumeId: string): Promise<void> {
  // DO requires detached before delete.
  const vol = await getDoVolume(volumeId).catch(() => null);
  if (vol?.droplet_ids?.length) {
    log("volume", `Volume ${volumeId} attached to ${vol.droplet_ids[0]}, detaching first`);
    try { await detachDoVolume(volumeId); }
    catch (err) { log("volume", `Detach before delete failed (will retry delete): ${err}`); }
  }
  await doApi(`/volumes/${volumeId}`, { method: "DELETE" });
  log("volume", `Volume ${volumeId} deleted`);
}
