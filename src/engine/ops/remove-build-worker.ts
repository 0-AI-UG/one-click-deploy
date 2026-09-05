import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

export type RemoveBuildWorkerInput = { workerId: number };

const remove: Step<RemoveBuildWorkerInput, { serverId: number; previousPool: string }> = {
  name: "remove_worker",
  label: "Remove OCD build worker",
  async run(ctx) {
    const worker = db.getBuildWorker(ctx.input.workerId);
    if (!worker) throw new Error("Build worker not found");
    const inUse = db.getBuildSources().some((source) => source.worker_id === worker.id);
    if (inUse) throw new Error("Build worker is still assigned to one or more repository sources");
    const server = db.getServer(worker.server_id);
    if (!server) throw new Error("Build worker server not found");
    const cleanup = await sshExec(
      server.ipv4,
      "set -eu; rm -rf /opt/ocd-build-worker",
      server.ssh_host_key || undefined,
    );
    if (cleanup.exitCode !== 0) throw new Error(cleanup.stderr.trim() || "Could not remove build-worker files");
    db.deleteBuildWorker(worker.id);
    db.updateServerPool(worker.server_id, worker.previous_pool || "general");
    return { serverId: worker.server_id, previousPool: worker.previous_pool };
  },
};

const definition: OpKindDefinition<RemoveBuildWorkerInput> = {
  kind: "remove_build_worker",
  label: "Remove OCD build worker",
  resourceKeys: (input) => [`builder:${input.workerId}`],
  steps: [remove],
};

registerOp(definition as OpKindDefinition<any>);
export default definition;
