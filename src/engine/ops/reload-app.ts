import { reloadAppEnvironment } from "../deploy/lifecycle.ts";
import { makeAppLifecycleOp, type AppLifecycleInput } from "./app-lifecycle.ts";

const reloadAppOp = makeAppLifecycleOp({
  kind: "reload_app",
  label: "Reload app environment",
  actionName: "recreate_replicas",
  actionLabel: "Recreate replicas",
  shouldSkip: (app) =>
    app.status === "paused" ||
    app.status === "sleeping" ||
    app.status === "destroying" ||
    app.status === "cleanup_failed" ||
    app.status === "deploying",
  skipLog: (app) => `app ${app.name} status='${app.status}' — environment reload skipped`,
  action: reloadAppEnvironment,
});

export default reloadAppOp;
export type ReloadAppInput = AppLifecycleInput;
