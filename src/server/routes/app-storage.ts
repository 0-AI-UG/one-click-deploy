import { appStorageMounts, measureStorage } from "../lib/storage-inventory.ts";
import { corsHeaders } from "../lib/cors.ts";
import { appScope, requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { inspectServerGc } from "../../shared/remote/index.ts";

export function selectCurrentAndRollback<T extends {
  id: number;
  status: string;
  image_digest: string;
  image_tag: string;
}>(deployments: T[]): { current: T | null; rollback: T | null } {
  const successful = deployments.filter((deployment) => deployment.status === "deployed");
  const current = successful[0] ?? null;
  const currentArtifact = current ? (current.image_digest || current.image_tag) : "";
  const rollback = successful.find((deployment) =>
    deployment.id !== current?.id &&
    (deployment.image_digest || deployment.image_tag) !== currentArtifact
  ) ?? null;
  return { current, rollback };
}

export async function handleGetAppStorage(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.view", appScope(appId));
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    // Runtime-only reconciles create history checkpoints for the same image.
    // Skip those duplicates so "rollback" means the previous artifact, not
    // merely the previous configuration revision.
    const { current, rollback } = selectCurrentAndRollback(db.getDeployments(appId));
    const servers = [...new Set(db.getReplicas(appId).map((replica) => replica.server_id))]
      .map((id) => db.getServer(id))
      .filter((server): server is NonNullable<typeof server> => !!server?.ipv4);
    const inventories = await Promise.all(servers.map(async (server) => ({
      server_id: server.id,
      server_name: server.name,
      inventory: await inspectServerGc(server.ipv4, server.ssh_host_key || undefined, {
        activeAppNames: [...new Set([
          ...db.getApps(server.id).map((candidate) => candidate.name),
          ...db.getApps().filter((candidate) => candidate.sleeping_server_id === server.id).map((candidate) => candidate.name),
        ])],
      }),
    })));
    const reclaimable = inventories.flatMap(({ server_id, server_name, inventory }) =>
      inventory.images
        .filter((image) => image.category.startsWith("reclaimable-") && image.refs.some((ref) => ref.startsWith(`${app.name}:`)))
        .map((image) => ({ server_id, server_name, ...image }))
    );
    return Response.json({
      mounts: await measureStorage(appStorageMounts(app)),
      current: current ? {
        deployment_id: current.id,
        image_size_bytes: current.image_size_bytes,
        archive_size_bytes: current.archive_size_bytes,
        transfer_size_bytes: current.transfer_size_bytes,
      } : null,
      rollback: rollback ? {
        deployment_id: rollback.id,
        image_size_bytes: rollback.image_size_bytes,
        archive_size_bytes: rollback.archive_size_bytes,
        transfer_size_bytes: rollback.transfer_size_bytes,
      } : null,
      reclaimable,
      reclaimable_image_bytes_upper_bound: reclaimable.reduce((sum, image) => sum + image.size_bytes, 0),
      caveat: "Docker image sizes include shared layers; reclaimable image bytes are an upper bound, not additive freed space.",
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
