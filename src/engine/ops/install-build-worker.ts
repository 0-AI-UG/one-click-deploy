import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { buildInstallWorkerScript, probeBuildWorker, runBuildWorkerInstall } from "../build-worker.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";

export type InstallBuildWorkerInput = { workerId: number; removalTokenSecretKey?: string };

const preflight: Step<InstallBuildWorkerInput, { serverId: number }> = {
  name: "preflight",
  label: "Verify dedicated build server",
  async run(ctx) {
    const worker = db.getBuildWorker(ctx.input.workerId);
    if (!worker) throw new Error("Build worker record not found");
    const server = db.getServer(worker.server_id);
    if (!server) throw new Error("Build worker server not found");
    if (db.getPanel()?.server_id === server.id || db.getApps(server.id).length || db.getServicesOnServer(server.id).length) {
      throw new Error("Build workers require a dedicated server with no panel, apps, or managed services");
    }
    if (server.pool !== "build-workers") throw new Error("Build worker server must be isolated in the build-workers pool");
    db.updateBuildWorker(worker.id, { status: "installing", last_error: "" });
    return { serverId: server.id };
  },
};

const install: Step<InstallBuildWorkerInput, { version: string; architecture: string }> = {
  name: "install_worker",
  label: "Install OCD BuildKit worker",
  async probe(ctx) {
    const worker = db.getBuildWorker(ctx.input.workerId);
    const server = worker ? db.getServer(worker.server_id) : null;
    if (!server) return null;
    const observed = await probeBuildWorker(server);
    return observed.online ? { version: observed.version, architecture: observed.architecture } : null;
  },
  async run(ctx) {
    const worker = db.getBuildWorker(ctx.input.workerId);
    const server = worker ? db.getServer(worker.server_id) : null;
    if (!worker || !server) throw new Error("Build worker or server disappeared during installation");
    const removalToken = ctx.input.removalTokenSecretKey
      ? await secretStore.get(ctx.input.removalTokenSecretKey)
      : "";
    try {
      const result = await runBuildWorkerInstall(server, buildInstallWorkerScript(removalToken || ""));
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Build worker installation failed");
      const observed = await probeBuildWorker(server);
      if (!observed.online) throw new Error(observed.error || "Build worker did not become ready");
      return { version: observed.version, architecture: observed.architecture };
    } catch (error) {
      db.updateBuildWorker(worker.id, { status: "error", last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
      throw error;
    } finally {
      if (ctx.input.removalTokenSecretKey) await secretStore.delete(ctx.input.removalTokenSecretKey);
    }
  },
};

const markReady: Step<InstallBuildWorkerInput, { ok: true }> = {
  name: "mark_ready",
  label: "Record build worker readiness",
  async run(ctx, prior) {
    const installed = prior.install_worker as { version: string; architecture: string };
    db.updateBuildWorker(ctx.input.workerId, {
      status: "online",
      last_error: "",
      worker_version: installed.version,
      architecture: installed.architecture,
      last_checked_at: new Date().toISOString(),
    });
    return { ok: true };
  },
};

const definition: OpKindDefinition<InstallBuildWorkerInput> = {
  kind: "install_build_worker",
  label: "Install OCD build worker",
  resourceKeys: (input) => {
    const worker = db.getBuildWorker(input.workerId);
    return [`builder:${input.workerId}`, ...(worker ? [`server:${worker.server_id}`] : [])];
  },
  steps: [preflight, install, markReady],
};

registerOp(definition as OpKindDefinition<any>);
export default definition;
