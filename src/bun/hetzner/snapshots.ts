import { hetznerApi } from "./api.ts";
import { pollAction } from "./actions.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

type HetznerAction = { id: number; status: string };
type HetznerImage = {
  id: number;
  status: "creating" | "available" | "unavailable";
  type: string;
  image_size?: number; // GB
  disk_size?: number; // GB
  description?: string;
  created?: string;
};
type HetznerServer = {
  id: number;
  status: string;
  public_net: { ipv4: { ip: string }; ipv6: { ip: string } };
  name: string;
};

type CreateImageResponse = { action: HetznerAction; image: HetznerImage };
type GetImageResponse = { image: HetznerImage };
type CreateServerResponse = {
  action: HetznerAction;
  server: HetznerServer;
};

/**
 * Issue a snapshot create on the given server. Returns once Hetzner has accepted
 * the request and assigned an image id — the snapshot itself is still being built
 * and must be polled with `getSnapshot` until status === "available".
 */
export async function snapshotServer(
  serverProviderId: string,
  description: string,
): Promise<{ snapshotId: string }> {
  log("snapshot", `Creating snapshot for server ${serverProviderId}`);
  const data = (await hetznerApi(
    `/servers/${serverProviderId}/actions/create_image`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "snapshot",
        description,
        labels: { managed_by: "one-click-deploy" },
      }),
    },
  )) as unknown as CreateImageResponse;
  const id = String(data.image.id);
  log("snapshot", `Snapshot create issued: image_id=${id} action_id=${data.action.id}`);
  return { snapshotId: id };
}

/**
 * Look up the current state of a snapshot. Maps Hetzner image statuses to a
 * provider-agnostic shape.
 */
export async function getSnapshot(
  snapshotId: string,
): Promise<{ status: "creating" | "available" | "failed"; sizeGb: number }> {
  const data = (await hetznerApi(`/images/${snapshotId}`)) as unknown as GetImageResponse;
  const img = data.image;
  let status: "creating" | "available" | "failed";
  if (img.status === "available") status = "available";
  else if (img.status === "creating") status = "creating";
  else status = "failed";
  // Hetzner reports `image_size` (used) once available; before then only
  // `disk_size` (allocated) is set. Either is fine for cost reporting.
  const sizeGb = Number(img.image_size ?? img.disk_size ?? 0);
  return { status, sizeGb };
}

/**
 * List every panel-managed snapshot (label `managed_by=one-click-deploy`).
 * Used by the freeze worker to guard against blowing the Hetzner project
 * snapshot quota (~100 per project at the time of writing).
 */
export async function listSnapshots(): Promise<Array<{
  snapshotId: string;
  description: string;
  sizeGb: number;
  status: "creating" | "available" | "failed";
}>> {
  const data = (await hetznerApi(
    "/images?type=snapshot&label_selector=managed_by%3Done-click-deploy&per_page=100",
  )) as unknown as { images: HetznerImage[] };
  return (data.images ?? []).map((img) => {
    let status: "creating" | "available" | "failed";
    if (img.status === "available") status = "available";
    else if (img.status === "creating") status = "creating";
    else status = "failed";
    return {
      snapshotId: String(img.id),
      description: img.description ?? "",
      sizeGb: Number(img.image_size ?? img.disk_size ?? 0),
      status,
    };
  });
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  log("snapshot", `Deleting snapshot ${snapshotId}`);
  try {
    await hetznerApi(`/images/${snapshotId}`, { method: "DELETE" });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("not found") || msg.includes("Resource not found")) {
      log("snapshot", `Snapshot ${snapshotId} already gone`);
      return;
    }
    throw err;
  }
  log("snapshot", `Snapshot ${snapshotId} deleted`);
}

/**
 * Create a new server from an existing snapshot, attaching the given volumes
 * at boot time. The volumes must already exist in the same location.
 */
export async function createServerFromSnapshot(opts: {
  name: string;
  snapshotId: string;
  serverType: string;
  location: string;
  sshKeyName: string;
  firewallId: number;
  volumeIds: string[];
}): Promise<HetznerServer> {
  log(
    "snapshot",
    `Creating server "${opts.name}" from snapshot ${opts.snapshotId} (volumes=[${opts.volumeIds.join(",")}])`,
  );
  const body: Record<string, unknown> = {
    name: opts.name,
    server_type: opts.serverType,
    location: opts.location,
    image: Number(opts.snapshotId),
    ssh_keys: [opts.sshKeyName],
    firewalls: [{ firewall: opts.firewallId }],
    labels: { managed_by: "one-click-deploy" },
    // Restored snapshots already have /etc/fstab entries; automount handles the rest.
    automount: true,
  };
  if (opts.volumeIds.length > 0) {
    body.volumes = opts.volumeIds.map((id) => Number(id));
  }
  const data = (await hetznerApi("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  })) as unknown as CreateServerResponse;
  log(
    "snapshot",
    `Server created from snapshot: id=${data.server.id} ipv4=${data.server.public_net.ipv4.ip}`,
  );
  return data.server;
}

// Re-export pollAction so callers that want to wait on the snapshot create
// action (rather than poll image status) have a single import surface.
export { pollAction };
