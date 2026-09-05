import { Card } from "./ui.tsx";
import { storageUsage, type StorageMount } from "../../../shared/storage-display.ts";

export function StorageMounts({ mounts, title = "Storage" }: { mounts: StorageMount[]; title?: string }) {
  return <Card className="p-4 space-y-3">
    <h3 className="font-bold text-sm">{title}</h3>
    {!mounts.length && <p className="text-xs text-muted">No persistent directories recorded.</p>}
    {mounts.map((mount, index) => <div key={`${mount.id}:${index}`} className="text-xs space-y-1 border-t border-fg/10 pt-2">
      <div className="font-bold">{mount.kind === "local-directory" ? "Server-local directory" : "Provider block volume"} · {mount.app_name} · {mount.state}</div>
      <div>{storageUsage(mount.used_bytes)}{mount.kind === "local-directory" && " · shares server disk · no separate storage charge"}</div>
      <div className="break-all text-muted">{mount.server_name || "Host unavailable"}: {mount.host_path}{mount.container_path && ` → ${mount.container_path}`}</div>
    </div>)}
  </Card>;
}
