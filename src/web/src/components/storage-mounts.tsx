import { Card } from "./ui.tsx";
import { storageUsage, type StorageMount } from "../../../shared/storage-display.ts";

export function StorageMounts({ mounts, title = "Storage" }: { mounts: StorageMount[]; title?: string }) {
  return <Card className="p-4 space-y-3">
    <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">{title}</h3>
    {!mounts.length && <p className="font-mono text-[10px] text-muted">No persistent directories recorded.</p>}
    {mounts.map((mount, index) => <div key={`${mount.id}:${index}`} className={`space-y-2 text-[10px] font-mono${index > 0 ? " border-t border-fg/10 pt-3" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <span className="text-muted">{mount.kind === "local-directory" ? "Server-local directory" : "Provider block volume"}</span>
        <span className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          <span className="text-fg font-bold break-all text-right">{mount.app_name}</span>
          <span className="text-[8px] font-bold border border-fg px-1 uppercase shrink-0">{mount.state}</span>
        </span>
      </div>
      <div className="flex justify-between gap-4"><span className="text-muted">Usage</span><span className="text-fg text-right">{storageUsage(mount.used_bytes)}</span></div>
      {mount.kind === "local-directory" && <div className="flex justify-between gap-4"><span className="text-muted">Allocation</span><span className="text-fg text-right">Shares server disk · no separate storage charge</span></div>}
      <div className="flex justify-between gap-4"><span className="text-muted">Server</span><span className="text-fg text-right break-all">{mount.server_name || "Host unavailable"}</span></div>
      <div className="flex justify-between gap-4"><span className="text-muted shrink-0">Host path</span><span className="text-fg text-right break-all min-w-0">{mount.host_path}</span></div>
      {mount.container_path && <div className="flex justify-between gap-4"><span className="text-muted shrink-0">Container path</span><span className="text-fg text-right break-all min-w-0">{mount.container_path}</span></div>}
    </div>)}
  </Card>;
}
