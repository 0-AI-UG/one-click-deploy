export type StorageMount = {
  id: string;
  kind: "local-directory" | "provider-volume";
  server_id: number | null;
  server_name: string;
  app_name: string;
  host_path: string;
  container_path: string;
  state: string;
  used_bytes: number | null;
};

export function localVolumeIdentity(id: string) {
  const match = /^local:(\d+):([a-z0-9][a-z0-9-]{0,127})$/.exec(id);
  return match ? { serverId: Number(match[1]), hostPath: `/var/lib/ocd/volumes/${match[2]}` } : null;
}

export function storageUsage(bytes: number | null) {
  return bytes == null ? "Usage unavailable" : `${(bytes / 1024 ** 3).toFixed(2)} GiB used`;
}
