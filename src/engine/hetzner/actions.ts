import { hetznerApi } from "./api.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

/**
 * Poll a Hetzner action until it reaches a terminal state ("success" or "error").
 * Throws if the action fails or times out.
 */
export async function pollAction(
  actionId: number,
  opts?: { intervalMs?: number; timeoutMs?: number; successAtProgress?: number }
): Promise<void> {
  const interval = opts?.intervalMs ?? 2000;
  const timeout = opts?.timeoutMs ?? 60000;
  const successAtProgress = opts?.successAtProgress;
  const deadline = Date.now() + timeout;

  log("action", `Polling action ${actionId} (interval=${interval}ms, timeout=${timeout}ms${successAtProgress != null ? `, successAtProgress=${successAtProgress}` : ""})`);

  type ActionResponse = { action: { status: string; progress: number; error?: { message: string } } };
  while (Date.now() < deadline) {
    const data = await hetznerApi(`/actions/${actionId}`) as unknown as ActionResponse;
    const status = data.action?.status;
    const progress = data.action?.progress;
    log("action", `Action ${actionId}: status=${status} progress=${progress}`);

    if (status === "success") {
      log("action", `Action ${actionId} completed successfully`);
      return;
    }

    if (status === "error") {
      const errorMsg = data.action.error?.message || "Unknown error";
      log("action", `Action ${actionId} failed: ${errorMsg}`);
      throw new Error(`Operation failed: ${errorMsg}`);
    }

    if (successAtProgress != null && typeof progress === "number" && progress >= successAtProgress) {
      log("action", `Action ${actionId} reached progress ${progress} >= ${successAtProgress}, treating as success`);
      return;
    }

    // status === "running" — wait and poll again
    await Bun.sleep(interval);
  }

  throw new Error("Operation timed out — Hetzner took too long to respond. Try again.");
}
