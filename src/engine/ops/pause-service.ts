import { makeServiceLifecycleOp, type ServiceLifecycleInput } from "./service-instances.ts";

const pauseServiceOp = makeServiceLifecycleOp({
  kind: "pause_service",
  label: "Pause service",
  actionName: "pause_instances",
  actionLabel: "Pause service instances",
  action: "pause",
  shouldSkip: (status) => status === "paused",
  skipLog: (name) => `service ${name} already paused — no work needed`,
});

export default pauseServiceOp;
export type PauseServiceInput = ServiceLifecycleInput;
