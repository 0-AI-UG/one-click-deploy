import { backupTick } from "./backups.ts";
import { alertTick } from "./alerts.ts";
import { recoveryPending } from "./recovery-state.ts";
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export async function protectionTick(): Promise<void> {
  if (busy || recoveryPending()) return;
  busy = true;
  try {
    try { await backupTick(); } catch { console.error("[panel-protection] Backup scheduling failed; check backup settings and storage connection"); }
    try { await alertTick(); } catch { console.error("[panel-protection] Alert evaluation failed"); }
  } finally { busy = false; }
}
export function startPanelProtection(): void {
  if (timer) return;
  void protectionTick();
  timer = setInterval(() => void protectionTick(), 30_000);
}
export function stopPanelProtection(): void { if (timer) clearInterval(timer); timer = undefined; }
