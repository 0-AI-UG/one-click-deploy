import type { OpContext } from "./types.ts";

export function operationAbort(ctx: Pick<OpContext, "isCancelRequested">): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const poll = setInterval(() => {
    if (ctx.isCancelRequested()) controller.abort(new Error("operation cancelled"));
  }, 500);
  if (ctx.isCancelRequested()) controller.abort(new Error("operation cancelled"));
  return {
    signal: controller.signal,
    dispose: () => clearInterval(poll),
  };
}
