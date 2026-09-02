import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { listPendingOperations, listRunningOperations } from "../../shared/db/operations.ts";
import { garbageCollectServer, inspectServerGc } from "../../engine/hetzner/prune.ts";

function protectedAppNames(serverId: number): string[] {
  const placed = db.getApps(serverId).map((app) => app.name);
  const sleeping = db.getApps()
    .filter((app) => app.sleeping_server_id === serverId)
    .map((app) => app.name);
  return [...new Set([...placed, ...sleeping])];
}

function protectedPanelImages(serverId: number): string[] {
  if (db.getPanel()?.server_id !== serverId) return [];
  return db.getPanelDeployments()
    .filter((deployment) => deployment.status === "deployed")
    .slice(0, 2)
    .map((deployment) => deployment.image_tag);
}

function activeOperationIds(): number[] {
  return [...new Set([
    ...listPendingOperations(10_000),
    ...listRunningOperations(),
  ].map((operation) => operation.id))];
}

function selectedServers(request: Request) {
  const raw = new URL(request.url).searchParams.get("server");
  const servers = db.getServers().filter((server) => server.status === "ready" && server.ipv4);
  if (!raw) return servers;
  const selected = /^\d+$/.test(raw)
    ? servers.find((server) => server.id === Number(raw))
    : servers.find((server) => server.name.toLowerCase() === raw.toLowerCase() || server.ipv4 === raw);
  if (!selected) throw new Error(`Ready server not found: ${raw}`);
  return [selected];
}

/** Dry-run inventory. This endpoint never deletes assets. */
export async function handleGcInventory(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "fleet.view");
    const inventories = [];
    for (const server of selectedServers(request)) {
      const activeAppNames = protectedAppNames(server.id);
      inventories.push({
        server: { id: server.id, name: server.name, ipv4: server.ipv4 },
        ...(await inspectServerGc(server.ipv4, server.ssh_host_key || undefined, {
          activeAppNames,
          protectedImageRefs: protectedPanelImages(server.id),
          activeOperationIds: activeOperationIds(),
        })),
        size_caveat: "Image sizes include shared layers and are not additive; reclaimable bytes is an upper bound.",
      });
    }
    return Response.json(inventories, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** Explicit execution removes inventory-proven unused OCD and foreign images
 * while preserving every container ancestor and protected deployment artifact. */
export async function handleGcExecute(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "servers.manage");
    const inventories = [];
    for (const server of selectedServers(request)) {
      const activeAppNames = protectedAppNames(server.id);
      inventories.push({
        server: { id: server.id, name: server.name, ipv4: server.ipv4 },
        ...(await garbageCollectServer(server.ipv4, server.ssh_host_key || undefined, {
          activeAppNames,
          protectedImageRefs: protectedPanelImages(server.id),
          activeOperationIds: activeOperationIds(),
          buildCacheKeepStorage: server.pool === "build-workers" ? "4GB" : "1GB",
        })),
        size_caveat: "Image sizes include shared layers. reclaimed_bytes is the observed root-filesystem free-space increase.",
      });
    }
    return Response.json(inventories, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
