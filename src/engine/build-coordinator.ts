import * as db from "../shared/db.ts";
import type { ServerRow } from "../shared/db/servers.ts";
import type { BuildTransport } from "./build-transport.ts";
import { BuildWorkerUnavailableError } from "./build-worker.ts";

const HEARTBEAT_INTERVAL_MS = 20_000;

export type BuildWorkerSelection = {
  workerId: number;
  server: ServerRow;
};

export type BuildCoordinator = {
  withWorker<T>(args: {
    operationId: number;
    preferredWorkerId?: number | null;
    excludedWorkerIds?: number[];
    run: (selection: BuildWorkerSelection) => Promise<T>;
  }): Promise<{ value: T; workerId: number }>;
};

function supportsLinuxAmd64(architecture: string): boolean {
  return architecture === "x86_64" || architecture === "amd64";
}

export function createBuildCoordinator(transport: BuildTransport): BuildCoordinator {
  return {
    async withWorker<T>(args: {
      operationId: number;
      preferredWorkerId?: number | null;
      excludedWorkerIds?: number[];
      run: (selection: BuildWorkerSelection) => Promise<T>;
    }): Promise<{ value: T; workerId: number }> {
      const observed = await Promise.all(db.getBuildWorkers().map(async (worker) => {
        const server = db.getServer(worker.server_id);
        if (!server || server.status !== "ready" || worker.draining || args.excludedWorkerIds?.includes(worker.id)) {
          return null;
        }
        try {
          const observation = await transport.probeWorker(server);
          db.updateBuildWorker(worker.id, {
            status: observation.online ? "online" : "offline",
            last_error: observation.error,
            worker_version: observation.version,
            architecture: observation.architecture,
            disk_free_bytes: observation.diskFreeBytes,
            last_checked_at: new Date().toISOString(),
          });
          if (!observation.online || !supportsLinuxAmd64(observation.architecture)) return null;
          return { worker: db.getBuildWorker(worker.id)!, server };
        } catch (error) {
          db.updateBuildWorker(worker.id, {
            status: "offline",
            last_error: error instanceof Error ? error.message : String(error),
            disk_free_bytes: 0,
            last_checked_at: new Date().toISOString(),
          });
          return null;
        }
      }));

      const candidates = observed
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => {
          const leftPreferred = left.worker.id === args.preferredWorkerId ? 1 : 0;
          const rightPreferred = right.worker.id === args.preferredWorkerId ? 1 : 0;
          if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
          if (left.worker.disk_free_bytes !== right.worker.disk_free_bytes) {
            return right.worker.disk_free_bytes - left.worker.disk_free_bytes;
          }
          const leftUsed = left.worker.last_used_at || "";
          const rightUsed = right.worker.last_used_at || "";
          if (leftUsed !== rightUsed) return leftUsed.localeCompare(rightUsed);
          return left.worker.id - right.worker.id;
        });

      const lease = db.tryAcquireBuildWorkerLease({
        operationId: args.operationId,
        candidateWorkerIds: candidates.map((candidate) => candidate.worker.id),
      });
      if (!lease) throw new Error("No compatible OCD build worker has available capacity");
      const selected = candidates.find((candidate) => candidate.worker.id === lease.worker_id);
      if (!selected) {
        db.releaseBuildWorkerLease({ operationId: args.operationId, leaseToken: lease.lease_token });
        throw new Error("Leased build worker disappeared from the candidate set");
      }

      let leaseLost = false;
      const heartbeat = setInterval(() => {
        try {
          if (!db.heartbeatBuildWorkerLease({ operationId: args.operationId, leaseToken: lease.lease_token })) {
            leaseLost = true;
          }
        } catch {
          leaseLost = true;
        }
      }, HEARTBEAT_INTERVAL_MS);

      let completed = false;
      try {
        let value: T;
        try {
          value = await args.run({ workerId: selected.worker.id, server: selected.server });
        } catch (error) {
          if (error instanceof BuildWorkerUnavailableError && error.workerId == null) {
            error.workerId = selected.worker.id;
          }
          throw error;
        }
        if (leaseLost || !db.heartbeatBuildWorkerLease({
          operationId: args.operationId,
          leaseToken: lease.lease_token,
        })) {
          throw new Error("Build worker lease was lost before publication could be committed");
        }
        if (!db.releaseBuildWorkerLease({ operationId: args.operationId, leaseToken: lease.lease_token })) {
          throw new Error("Build worker lease could not be released safely");
        }
        completed = true;
        return { value, workerId: selected.worker.id };
      } finally {
        clearInterval(heartbeat);
        if (!completed) {
          try {
            db.releaseBuildWorkerLease({ operationId: args.operationId, leaseToken: lease.lease_token });
          } catch {
            // Preserve the build/fencing error; lease expiry is the recovery path.
          }
        }
      }
    },
  };
}
