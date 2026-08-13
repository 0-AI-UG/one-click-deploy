import { makeServiceLifecycleOp, type ServiceLifecycleInput } from "./service-instances.ts";

const unpauseServiceOp = makeServiceLifecycleOp({
  kind: "unpause_service",
  label: "Unpause service",
  actionName: "unpause_instances",
  actionLabel: "Unpause service instances",
  action: "unpause",
  shouldSkip: (status) => status !== "paused",
  skipLog: (name, status) => `service ${name} is '${status}' (not paused) — no work needed`,
});

export default unpauseServiceOp;
export type UnpauseServiceInput = ServiceLifecycleInput;
