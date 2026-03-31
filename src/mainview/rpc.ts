import { Electroview } from "electrobun/view";
import type { DeployAppRPC } from "../shared/rpc.ts";

type ProgressData = { app_name: string; step: string; detail: string };
type ProgressListener = (data: ProgressData) => void;

const progressListeners = new Set<ProgressListener>();

const rpc = Electroview.defineRPC<DeployAppRPC>({
  maxRequestTime: 600_000,
  handlers: {
    requests: {},
    messages: {
      deployProgress: (data: ProgressData) => {
        for (const fn of progressListeners) fn(data);
      },
    },
  },
});

const electroview = new Electroview({ rpc });

export function onDeployProgress(fn: ProgressListener): () => void {
  progressListeners.add(fn);
  return () => { progressListeners.delete(fn); };
}

// Lazy proxy so we don't dereference electroview.rpc at module load time
export const request = new Proxy({} as any, {
  get(_target, prop) {
    const rpcRef = electroview.rpc;
    if (!rpcRef) throw new Error("RPC not ready");
    return (rpcRef.request as any)[prop];
  },
});
