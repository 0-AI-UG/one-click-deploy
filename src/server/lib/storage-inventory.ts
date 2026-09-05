import * as db from "../../shared/db.ts";
import { localVolumeIdentity, type StorageMount } from "../../shared/storage-display.ts";
import { sshExec } from "../../shared/remote/index.ts";

export function appStorageMounts(app: ReturnType<typeof db.getApps>[number]): StorageMount[] {
  const local = localVolumeIdentity(app.volume_id);
  const serverId = local?.serverId ?? db.getReplicas(app.id)[0]?.server_id ?? app.sleeping_server_id ?? null;
  const server = serverId ? db.getServer(serverId) : null;
  const mounts: StorageMount[] = [];
  const add = (id: string, mount: string, kind: StorageMount["kind"]) => {
    const [host = "", container = ""] = mount.split(":");
    mounts.push({ id, kind, server_id: serverId, server_name: server?.name || "", app_name: app.name,
      host_path: local && id === app.volume_id ? local.hostPath : host,
      container_path: container, state: "attached", used_bytes: null });
  };
  if (app.volume_id) add(app.volume_id, app.volume_mount, local || app.volume_driver === "local-directory" ? "local-directory" : "provider-volume");
  for (const mount of db.parseExtraVolumes(app.extra_volumes)) add(mount, mount, "local-directory");
  return mounts;
}

export function localStorageInventory(): StorageMount[] {
  const mounts = db.getApps().flatMap(appStorageMounts).filter(m => m.kind === "local-directory");
  for (const retired of db.getRetiredVolumes()) {
    const local = localVolumeIdentity(retired.provider_volume_id);
    if (!local || retired.state === "deleted" || mounts.some(m => m.id === retired.provider_volume_id)) continue;
    mounts.push({ id: retired.provider_volume_id, kind: "local-directory", server_id: local.serverId,
      server_name: db.getServer(local.serverId)?.name || "", app_name: retired.former_resource_name,
      host_path: local.hostPath, container_path: "", state: "retained", used_bytes: null });
  }
  return mounts;
}

const usageCache = new Map<string, { until: number; bytes: number | null }>();

export async function measureStorage(mounts: StorageMount[]): Promise<StorageMount[]> {
  return Promise.all(mounts.map(async mount => {
    const server = mount.server_id ? db.getServer(mount.server_id) : null;
    if (!server || !mount.host_path.startsWith("/")) return mount;
    const key = `${server.id}:${mount.host_path}`;
    const cached = usageCache.get(key);
    if (cached && cached.until > Date.now()) return { ...mount, used_bytes: cached.bytes };
    for (const [key, entry] of usageCache) if (entry.until <= Date.now()) usageCache.delete(key);
    usageCache.set(key, { until: Date.now() + 60_000, bytes: null });
    const quoted = "'" + mount.host_path.replaceAll("'", "'\\''") + "'";
    try {
      const result = await sshExec(server.management_address || server.ipv4,
        `timeout 5 du -sk -- ${quoted}`, server.ssh_host_key || undefined,
        { user: server.ssh_user || "root", port: server.ssh_port || 22 });
      const kb = Number(result.stdout.trim().split(/\s+/)[0]);
      if (result.exitCode === 0 && result.stdout.trim() && Number.isFinite(kb) && kb >= 0) {
        usageCache.set(key, { until: Date.now() + 60_000, bytes: kb * 1024 });
        return { ...mount, used_bytes: kb * 1024 };
      }
    } catch { /* A missing/offline directory must not hide the inventory. */ }
    return mount;
  }));
}
