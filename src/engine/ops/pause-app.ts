import { pauseApp } from "../deploy/lifecycle.ts";
import { makeAppLifecycleOp, type AppLifecycleInput } from "./app-lifecycle.ts";

const pauseAppOp = makeAppLifecycleOp({
  kind: "pause_app",
  label: "Pause app",
  actionName: "pause_replicas",
  actionLabel: "Pause replicas",
  shouldSkip: (app) => app.status === "paused",
  skipLog: (app) => `app ${app.name} already paused — no work needed`,
  action: pauseApp,
});

export default pauseAppOp;
export type PauseAppInput = AppLifecycleInput;
