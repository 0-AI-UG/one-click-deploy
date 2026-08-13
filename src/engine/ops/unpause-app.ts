import { makeAppLifecycleOp, type AppLifecycleInput } from "./app-lifecycle.ts";

const unpauseAppOp = makeAppLifecycleOp({
  kind: "unpause_app",
  label: "Unpause app",
  actionName: "unpause_replicas",
  actionLabel: "Unpause replicas",
  // Already running/unhealthy means no unpause needed.
  shouldSkip: (app) => app.status !== "paused",
  skipLog: (app) => `app ${app.name} is '${app.status}' (not paused) — no work needed`,
  action: "unpause",
  syncIngress: true,
});

export default unpauseAppOp;
export type UnpauseAppInput = AppLifecycleInput;
