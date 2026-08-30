import * as db from "../shared/db.ts";
import { BuildWorkerUnavailableError } from "./build-worker.ts";
import type { BuildCoordinator, BuildWorkerSelection } from "./build-coordinator.ts";
import type { OpContext } from "./types.ts";

export async function withBuildFailover<T>(args: {
  ctx: Pick<OpContext, "opId" | "isCancelRequested" | "log">;
  coordinator: BuildCoordinator;
  preferredWorkerId?: number | null;
  run: (selection: BuildWorkerSelection) => Promise<T>;
}): Promise<{ value: T; workerId: number }> {
  const excludedWorkerIds: number[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await args.coordinator.withWorker({
        operationId: args.ctx.opId,
        preferredWorkerId: args.preferredWorkerId,
        excludedWorkerIds,
        run: args.run,
      });
    } catch (error) {
      const retryable = error instanceof BuildWorkerUnavailableError &&
        error.workerId != null &&
        !args.ctx.isCancelRequested() &&
        db.listBuildArtifacts(args.ctx.opId).length === 0 &&
        attempt < 2;
      if (!retryable) throw error;
      excludedWorkerIds.push(error.workerId!);
      args.ctx.log(`Build worker #${error.workerId} became unavailable; retrying once on another worker`);
    }
  }
  throw new Error("Build failover attempts exhausted");
}
