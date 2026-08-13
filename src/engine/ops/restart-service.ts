import { makeServiceLifecycleOp, type ServiceLifecycleInput } from "./service-instances.ts";

const restartServiceOp = makeServiceLifecycleOp({
  kind: "restart_service",
  label: "Restart service",
  actionName: "restart_instances",
  actionLabel: "Restart service instances",
  action: "restart",
  shouldSkip: (status) => status === "paused" || status === "deploying",
  skipLog: (name, status) => `service ${name} status='${status}' — restart skipped`,
  requireInstances: true,
});

export default restartServiceOp;
export type RestartServiceInput = ServiceLifecycleInput;
